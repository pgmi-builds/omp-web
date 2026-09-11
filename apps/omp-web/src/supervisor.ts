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
 * foreign prompt — found while replaying file growth past the shared cache entry's cursor.
 */
import { statSync } from "node:fs";
import { SessionPreparation, SessionSeq, type Session, type SessionEvent } from "@deepseek-ai/dsh-session";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { scanForeignWriters } from "./omp-store.js";
import { getBridgeStore } from "./store/index.js";
import { eventsForSessionFile, ingestSessionFileGrowth, sessionCacheEntryOf } from "./session-persistence-omp.js";
import { FILE_FOLLOW_INTERVAL_MS, SHADOW_TTL_MS, TRANSITION_FOLLOW_INTERVAL_MS } from "./knobs.js";

export type SupervisorRole = "cold" | "shadow" | "held" | "avoiding";

/** The slice of `ctx.sessions` the supervisor uses to materialize shadows. */
interface SessionsSlice {
  prepare(id: string, init: { seed?: SessionEvent[]; meta?: Record<string, unknown> }): Session;
  enter(session: Session): () => void;
  announce(session: Session): void;
  /** Membership probe: an id already live in the store must not be re-prepared (prepare throws). */
  get(id: string): Session | undefined;
}

type ReplayedEvent = SessionEvent & { surfaceOp?: "append"; sourceEventSeqs?: number[] };

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
  foreignPid?: number;
  shadow?: ShadowProjection;
  /** True once external writes were noted in this episode (reset on hold). */
  externalNoted: boolean;
  /** Avoidance hit while no shadow projection existed (create-held); note on materialize. */
  pendingNote: boolean;
  /** Guards the async shadow materialize against concurrent re-entry (same-id double enter). */
  materializing: boolean;
  /** Guards the async follow ingest against concurrent re-entry (double delta append). */
  ingesting: boolean;
  /** In-flight fresh-hold baseline fill (awaited by the first ingest). */
  pendingBaseline?: Promise<void>;
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
    if (entry.role === "cold" && !entry.materializing && this.sessions !== undefined) {
      entry.materializing = true;
      void this.#materialize(id, entry);
    }
  }
  /** Sync entries against the store; drop gone files; refresh role-agnostic state. */
  reconcile(): void {
    const store = getBridgeStore();
    if (store === undefined) return;
    const seen = new Set<string>();
    for (const row of store.list()) {
      const id = row.dsh_session_id;
      seen.add(id);
      const entry = this.entries.get(id);
      if (entry === undefined) {
        this.entries.set(id, { role: "cold", file: row.session_file, lastViewedAt: 0, lastFollowAt: 0, externalNoted: false, pendingNote: false, materializing: false, ingesting: false, knownUserTexts: new Set() });
      } else {
        entry.file = row.session_file;
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
    if (file !== "" && sessionCacheEntryOf(file) === undefined) {
      // Fresh hold without a prior fill: baseline the shared cache entry at
      // the file's current end so only records written AFTER this point are
      // judged (no history false positives — historical user texts are not in
      // knownUserTexts). Fire-and-forget; the fill is single-flight.
      entry.pendingBaseline = this.#baselineFile(id, file);
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
    // Teardown is detach-only: the shared cache entry is NOT re-read here. A
    // shadow demotion refills via #materialize (advancing the cursor past our
    // child's writes); a cold demotion never re-ingests.
    if (entry.role === "shadow" && this.sessions !== undefined && entry.shadow === undefined) {
      void this.#materialize(id, entry);
    }
    // Event-driven teardown stat: reflect the file's final size/mtime now
    // (the periodic reconcile would pick it up on its next cycle anyway).
    if (entry.file !== "") {
      getBridgeStore()?.updateStat(id, statSize(entry.file), statMtime(entry.file));
    }
  }

  /** Record a user prompt we delivered, so a foreign user record is distinguishable. */
  reportUserText(id: string, text: string): void {
    if (text === "") return;
    this.#entry(id).knownUserTexts.add(text);
  }

  /** One synchronous follow pass (test/diagnostic entry; same gating as a tick). */
  /** One follow pass (test/diagnostic entry; same gating as a tick). */
  async poll(): Promise<void> {
    if (this.sessions === undefined) return;
    const foreign = scanForeignWriters();
    const now = Date.now();
    const work: Promise<void>[] = [];
    for (const [id, entry] of this.entries) {
      const pending = this.#followEntry(id, entry, foreign, now);
      if (pending !== undefined) work.push(pending);
    }
    await Promise.all(work);
  }

  /** The follow loop: one tick, one /proc pass, per-entry cadence gating. */
  startFollow(): () => void {
    const tick = (): void => {
      if (this.disposed || this.sessions === undefined) return;
      const foreign = scanForeignWriters();
      const now = Date.now();
      for (const [id, entry] of this.entries) void this.#followEntry(id, entry, foreign, now);
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
      entry = { role: "cold", file: "", lastViewedAt: 0, lastFollowAt: 0, externalNoted: false, pendingNote: false, materializing: false, ingesting: false, knownUserTexts: new Set() };
      this.entries.set(id, entry);
    }
    return entry;
  }

  #followEntry(id: string, entry: Entry, foreign: Map<string, number>, now: number): Promise<void> | undefined {
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
        const pending = shadow !== undefined ? this.#ingest(id, entry, shadow.session) : undefined;
        if (SHADOW_TTL_MS !== 0 && now - entry.lastViewedAt > SHADOW_TTL_MS && shadow !== undefined) {
          shadow.detach();
          entry.shadow = undefined;
          entry.role = "cold";
        }
        return pending;
      }
      case "held": {
        // Content watch while we own the RPC child: a user record we never
        // delivered appearing in the file is a foreign writer (TUI) — avoid.
        return this.#ingest(id, entry);
      }
      case "avoiding":
      case "cold":
        return undefined;
    }
  }

  /**
   * Ingest transcript growth past the shared cache entry's cursor. The lenient
   * delta is scanned for foreign user records REGARDLESS of the entry validation
   * outcome; when `appendTo` is given (shadow), the VALIDATED delta is appended
   * to the live projection. Fires the external-writer note / avoidance when an
   * incremental user record's text was never delivered by us.
   */
  async #ingest(id: string, entry: Entry, appendTo?: Session): Promise<void> {
    if (entry.file === "" || entry.ingesting) return;
    entry.ingesting = true;
    try {
      if (entry.pendingBaseline !== undefined) {
        await entry.pendingBaseline;
        entry.pendingBaseline = undefined;
      }
      const { foreign, shadow } = await ingestSessionFileGrowth(entry.file, id, this.fillLogger);
      // Foreign detection runs on the lenient delta (always, even on validation failure).
      let foreignText = "";
      for (const event of foreign) {
        if (foreignText === "" && event.type === "user/message") {
          const text = userText(event.data);
          if (text !== undefined && text !== "" && !entry.knownUserTexts.has(text)) foreignText = text;
        }
      }
      // Shadow append runs on the validated delta (empty on validation failure → no invalid appends).
      if (appendTo !== undefined) {
        for (const event of shadow as ReplayedEvent[]) {
          if (event.surfaceOp === "append") {
            // Only cite source seqs when the replay actually provides them: an
            // empty array trips dsh-session's assertProvenance on every
            // non-assistant/message append (user/message, tool/result) — the
            // live bridge omits the key entirely, so mirror that.
            appendTo.append(event.type, event.data, event.sourceEventSeqs === undefined
              ? { surfaceOp: "append" }
              : { surfaceOp: "append", sourceEventSeqs: event.sourceEventSeqs.map((seq) => SessionSeq(seq)) });
          } else {
            appendTo.append(event.type, event.data);
          }
        }
      }
      if (foreignText !== "") this.#onForeignUser(id, entry, foreignText);
    } catch {
      // A transient read/stat/replay failure must never wedge a follow tick.
    } finally {
      entry.ingesting = false;
    }
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
    if (entry.shadow !== undefined || this.sessions === undefined) {
      entry.materializing = false;
      return;
    }
    // Idempotency: the id may have gone live between scheduling and this run
    // (e.g. a concurrent resume published it). SessionStore.prepare throws on a
    // duplicate id — treat live as already-materialized (observed upstream as
    // `materialize ... failed: session "X" already exists` in prod journals).
    if (this.sessions.get(id) !== undefined) {
      entry.materializing = false;
      return;
    }
    const row = getBridgeStore()?.byFile(entry.file);
    try {
      const seed = await eventsForSessionFile(entry.file, id, this.fillLogger);
      const preparation = await SessionPreparation.create(
        this.sessions.prepare(id, {
          seed,
          meta: { ...(row === undefined ? {} : { createdAt: row.created_at }), ...(row === undefined || row.cwd === null ? {} : { cwd: row.cwd }) },
        }),
      );
      const detach = this.sessions.enter(preparation.session);
      this.sessions.announce(preparation.session);
      preparation[Symbol.dispose]();
      entry.shadow = { session: preparation.session, detach };
      entry.role = "shadow";
      entry.externalNoted = false;
      if (entry.pendingNote) {
        entry.pendingNote = false;
        this.#appendForeignNote(preparation.session);
      }
    } catch (error) {
      this.log(`materialize ${id} failed: ${String(error)}`);
    } finally {
      entry.materializing = false;
    }
  }

  /** The persistence fill's logger shape (fail-soft `warn`), backed by our log. */
  private get fillLogger(): { warn: (message: string) => void } {
    return { warn: (message) => this.log(message) };
  }

  /** Fill the shared cache entry to baseline its cursor (fresh hold). */
  async #baselineFile(id: string, file: string): Promise<void> {
    await eventsForSessionFile(file, id, this.fillLogger);
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
