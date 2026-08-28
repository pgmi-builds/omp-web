/**
 * Session supervisor — the bridge's per-session authority over OMP's store.
 *
 * Owns the cold/shadow/held/avoiding state machine and the cold projection
 * that pushes a VIEWED (but not yet resumed) session's file growth through
 * the mux as a live, agent-less session (S1-verified).
 *
 * Foreign-writer detection is CONTENT-based: omp 18's session writer opens
 * the transcript per write and closes it (verified empirically — no process
 * holds a persistent write fd, TUI included), so /proc fd scans are only an
 * auxiliary badge signal. The primary trigger is an incremental user-role
 * record whose text was never delivered by us (`knownUserTexts`) — i.e. a
 * foreign prompt — found while replaying file growth past a per-entry cursor.
 */
import { statSync } from "node:fs";
import { SessionPreparation, type Session, type SessionEvent } from "@deepseek-ai/dsh-session";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { readOmpMessages, scanForeignWriters, scanOmpSessions } from "./omp-store.js";
import { replayOmpTranscript } from "./replay.js";
import { dashIdOf } from "./pairing.js";
import { FILE_FOLLOW_INTERVAL_MS, SHADOW_TTL_MS, TRANSITION_FOLLOW_INTERVAL_MS } from "./knobs.js";

export type SupervisorRole = "cold" | "shadow" | "held" | "avoiding";

/** The slice of `ctx.sessions` the supervisor uses to materialize shadows. */
interface SessionsSlice {
  prepare(id: string, init: { seed?: SessionEvent[]; meta?: Record<string, unknown> }): Session;
  enter(session: Session): () => void;
  announce(session: Session): void;
}

type ReplayedEvent = SessionEvent & { surfaceOp?: "append"; sourceEventSeqs?: number[] };

/** Content cursor: how far into the transcript this entry has ingested. */
interface Cursor {
  lastSeq: number;
  size: number;
  mtimeMs: number;
}

interface ShadowProjection {
  session: Session;
  detach: () => void;
}
function userText(message: unknown): string | undefined {
  if (message === null || typeof message !== "object" || !("content" in message)) return undefined;
  const { content } = message as { content?: unknown };
  if (!Array.isArray(content)) return undefined;
  return content
    .filter((block): block is { type: string; text?: string } => typeof block === "object" && block !== null && block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n");
}

interface Entry {
  role: SupervisorRole;
  file: string;
  title?: string;
  createdAt?: number;
  foreignPid?: number;
  shadow?: ShadowProjection;
  cursor?: Cursor;
  /** True once external writes were noted in this episode (reset on hold). */
  externalNoted: boolean;
  /** Avoidance hit while no shadow projection existed (create-held); note on materialize. */
  pendingNote: boolean;
  lastViewedAt: number;
  lastFollowAt: number;
  knownUserTexts: Set<string>;
}

export class Supervisor {
  private sessions?: SessionsSlice;
  private log: (msg: string) => void = () => {};
  private entries = new Map<string, Entry>();
  private avoidanceListeners = new Set<(id: string) => void>();
  private disposed = false;

  /** Wire the runtime dependencies once, before any tick. */
  attach(sessions: unknown, log: (msg: string) => void): void {
    this.sessions = sessions as SessionsSlice;
    this.log = log;
  }

  /** Register a listener fired when a foreign user prompt triggers avoidance. */
  onAvoidance(listener: (id: string) => void): () => void {
    this.avoidanceListeners.add(listener);
    return () => this.avoidanceListeners.delete(listener);
  }

  /** Cold-read signal from the persistence layer: a frontend asked for this session. */
  noteView(id: string): void {
    const entry = this.#entry(id);
    entry.lastViewedAt = Date.now();
    if (entry.role === "cold" && this.sessions !== undefined) void this.#materialize(id, entry);
  }
  /** Sync entries against the store; drop gone files; refresh role-agnostic state. */
  reconcile(): void {
    const seen = new Set<string>();
    for (const native of scanOmpSessions().values()) {
      const id = dashIdOf(native);
      seen.add(id);
      const entry = this.entries.get(id);
      if (entry === undefined) {
        this.entries.set(id, { role: "cold", file: native.ompSessionFile, title: native.title, createdAt: native.createdAt, lastViewedAt: 0, lastFollowAt: 0, externalNoted: false, pendingNote: false, knownUserTexts: new Set() });
      } else {
        entry.file = native.ompSessionFile;
        entry.title = native.title;
        entry.createdAt = native.createdAt;
      }
    }
    for (const [id, entry] of this.entries) {
      if (seen.has(id)) continue;
      entry.shadow?.detach();
      this.entries.delete(id);
    }
  }

  /** Badge data for one dash id: fd-based foreign pid (auxiliary) and content-based divergence. */
  badge(id: string): { foreignPid?: number; diverged?: boolean } {
    const entry = this.entries.get(id);
    if (entry === undefined) return {};
    return entry.foreignPid === undefined
      ? (entry.externalNoted ? { diverged: true } : {})
      : { foreignPid: entry.foreignPid, ...(entry.externalNoted ? { diverged: true } : {}) };
  }

  /** L1 gate: is this session mid-avoidance (prompts must be refused early)? */
  isAvoiding(id: string): boolean {
    return this.entries.get(id)?.role === "avoiding";
  }

  /** The shadow's live Session, if this id has one (promotion reuse). */
  shadowSessionOf(id: string): Session | undefined {
    return this.entries.get(id)?.shadow?.session;
  }

  /** Mark a session as held by a live RPC child. Baselines the content cursor. */
  onHeld(id: string, file: string): void {
    const entry = this.#entry(id);
    entry.role = "held";
    entry.file = file;
    entry.foreignPid = undefined;
    entry.externalNoted = false;
    if (entry.cursor === undefined && file !== "") {
      // Fresh hold without a shadow: baseline at the file's current end so
      // only records written AFTER this point are judged (no history false
      // positives — historical user texts are not in knownUserTexts).
      const events = replayOmpTranscript(readOmpMessages(file), entry.title, entry.createdAt);
      entry.cursor = { lastSeq: events.length, size: statSize(file), mtimeMs: statMtime(file) };
    }
  }

  /** The RPC child tore down (idle exit or avoidance): demote to shadow or cold. */
  onHeldDisposed(id: string): void {
    const entry = this.entries.get(id);
    if (entry === undefined) return;
    entry.role = entry.lastViewedAt > 0 ? "shadow" : "cold";
    entry.knownUserTexts.clear();
    entry.foreignPid = undefined;
    entry.externalNoted = false;
    // Re-baseline the cursor at the file's end: our own child's writes must
    // not read back as foreign on the next watch pass.
    if (entry.cursor !== undefined && entry.file !== "") {
      const events = replayOmpTranscript(readOmpMessages(entry.file), entry.title, entry.createdAt);
      entry.cursor = { lastSeq: events.length, size: statSize(entry.file), mtimeMs: statMtime(entry.file) };
    }
    if (entry.role === "shadow" && this.sessions !== undefined && entry.shadow === undefined) {
      void this.#materialize(id, entry);
    }
  }

  /** Record a user prompt we delivered, so a foreign user record is distinguishable. */
  reportUserText(id: string, text: string): void {
    if (text === "") return;
    this.#entry(id).knownUserTexts.add(text);
  }

  /** One synchronous follow pass (test/diagnostic entry; same gating as a tick). */
  poll(): void {
    if (this.sessions === undefined) return;
    const foreign = scanForeignWriters();
    const now = Date.now();
    for (const [id, entry] of this.entries) this.#followEntry(id, entry, foreign, now);
  }

  /** The follow loop: one tick, one /proc pass, per-entry cadence gating. */
  startFollow(): () => void {
    const tick = (): void => {
      if (this.disposed || this.sessions === undefined) return;
      const foreign = scanForeignWriters();
      const now = Date.now();
      for (const [id, entry] of this.entries) this.#followEntry(id, entry, foreign, now);
    };
    tick();
    const timer = setInterval(tick, 1_000);
    timer.unref();
    return () => {
      this.disposed = true;
      clearInterval(timer);
    };
  }
  #entry(id: string): Entry {
    let entry = this.entries.get(id);
    if (entry === undefined) {
      entry = { role: "cold", file: "", lastViewedAt: 0, lastFollowAt: 0, externalNoted: false, pendingNote: false, knownUserTexts: new Set() };
      this.entries.set(id, entry);
    }
    return entry;
  }

  #followEntry(id: string, entry: Entry, foreign: Map<string, number>, now: number): void {
    const cadence = entry.role === "shadow" || entry.role === "held"
      ? FILE_FOLLOW_INTERVAL_MS
      : entry.role === "avoiding"
        ? TRANSITION_FOLLOW_INTERVAL_MS
        : 0;
    if (cadence === 0 || now - entry.lastFollowAt < cadence) return;
    entry.lastFollowAt = now;

    switch (entry.role) {
      case "shadow": {
        const shadow = entry.shadow;
        // Auxiliary fd badge (usually absent on omp 18 — content is the signal).
        entry.foreignPid = foreign.get(entry.file);
        if (shadow !== undefined) this.#ingest(id, entry, shadow.session);
        if (SHADOW_TTL_MS !== 0 && now - entry.lastViewedAt > SHADOW_TTL_MS && shadow !== undefined) {
          shadow.detach();
          entry.shadow = undefined;
          entry.role = "cold";
        }
        break;
      }
      case "held": {
        // Content watch while we own the RPC child: a user record we never
        // delivered appearing in the file is a foreign writer (TUI) — avoid.
        this.#ingest(id, entry);
        break;
      }
      case "avoiding":
      case "cold":
        break;
    }
  }

  /**
   * Ingest transcript growth past the entry's cursor in one replay. When
   * `appendTo` is given (shadow), incremental events are appended to the live
   * projection; otherwise (held) only foreign-user detection runs. Fires the
   * external-writer note / avoidance when an incremental user record's text
   * was never delivered by us.
   */
  #ingest(id: string, entry: Entry, appendTo?: Session): void {
    const cursor = entry.cursor;
    if (cursor === undefined || entry.file === "") return;
    let size: number;
    let mtimeMs: number;
    try {
      const stat = statSync(entry.file);
      size = stat.size;
      mtimeMs = stat.mtimeMs;
    } catch {
      return;
    }
    if (size === cursor.size && mtimeMs === cursor.mtimeMs) return;
    const events = replayOmpTranscript(readOmpMessages(entry.file), entry.title, entry.createdAt) as ReplayedEvent[];
    if (events.length <= cursor.lastSeq) {
      // Growth-free rewrite (title-slot in-place update): re-baseline stat only.
      cursor.size = size;
      cursor.mtimeMs = mtimeMs;
      return;
    }
    let foreignText = "";
    for (const event of events) {
      if (event.seq < cursor.lastSeq) continue;
      if (appendTo !== undefined) {
        if (event.surfaceOp === "append") {
          // Only cite source seqs when the replay actually provides them: an
          // empty array trips dsh-session's assertProvenance on every
          // non-assistant/message append (user/message, tool/result) — the
          // live bridge omits the key entirely, so mirror that.
          appendTo.append(event.type, event.data, event.sourceEventSeqs === undefined
            ? { surfaceOp: "append" }
            : { surfaceOp: "append", sourceEventSeqs: event.sourceEventSeqs });
        } else {
          appendTo.append(event.type, event.data);
        }
      }
      if (foreignText === "" && event.type === "user/message") {
        const text = userText(event.data);
        if (text !== undefined && text !== "" && !entry.knownUserTexts.has(text)) foreignText = text;
      }
    }
    cursor.lastSeq = events.length;
    cursor.size = size;
    cursor.mtimeMs = mtimeMs;
    if (foreignText !== "") this.#onForeignUser(id, entry, foreignText);
  }

  /** An incremental user record we never delivered: note it, or avoid. */
  #onForeignUser(id: string, entry: Entry, text: string): void {
    if (entry.role === "held") {
      entry.externalNoted = true;
      if (entry.shadow !== undefined) this.#appendForeignNote(entry.shadow.session);
      else entry.pendingNote = true;
      this.#beginAvoiding(id, entry);
      return;
    }
    if (entry.role === "shadow" && !entry.externalNoted) {
      entry.externalNoted = true;
      this.log(`session ${entry.file}: external writes detected (spectating)`);
      if (entry.shadow !== undefined) this.#appendForeignNote(entry.shadow.session);
    }
  }

  #beginAvoiding(id: string, entry: Entry): void {
    entry.role = "avoiding";
    this.log(`session ${entry.file} foreign user prompt — avoiding`);
    for (const listener of this.avoidanceListeners) listener(id);
  }

  async #materialize(id: string, entry: Entry): Promise<void> {
    if (entry.shadow !== undefined || this.sessions === undefined) return;
    const native = [...scanOmpSessions().values()].find((n) => n.ompSessionFile === entry.file);
    const seed = replayOmpTranscript(readOmpMessages(entry.file), entry.title ?? native?.title, entry.createdAt ?? native?.createdAt);
    try {
      const preparation = await SessionPreparation.create(
        this.sessions.prepare(id, {
          seed,
          meta: { ...(native?.createdAt === undefined ? {} : { createdAt: native.createdAt }), ...(native?.cwd === undefined ? {} : { cwd: native.cwd }) },
        }),
      );
      const detach = this.sessions.enter(preparation.session);
      this.sessions.announce(preparation.session);
      preparation[Symbol.dispose]();
      entry.shadow = { session: preparation.session, detach };
      entry.cursor = { lastSeq: seed.length, size: statSize(entry.file), mtimeMs: statMtime(entry.file) };
      entry.role = "shadow";
      entry.externalNoted = false;
      if (entry.pendingNote) {
        entry.pendingNote = false;
        this.#appendForeignNote(preparation.session);
      }
    } catch (error) {
      this.log(`materialize ${id} failed: ${String(error)}`);
    }
  }

  #appendForeignNote(session: Session): void {
    const note = createUserMessage({
      content: [{ type: "text", text: "检测到外部进程正在写入此会话（终端 OMP），本视图为只读围观。" }],
      source: { kind: "plugin", plugin: "omp-supervisor" },
    });
    try {
      session.append("user/message", note, { surfaceOp: "append" });
    } catch {
      // Note synthesis must never wedge a shadow tick.
    }
  }
}

function statSize(file: string): number {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
}
function statMtime(file: string): number {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

/** Module singleton — the persistence layer reports views through this. */
export const supervisor = new Supervisor();
