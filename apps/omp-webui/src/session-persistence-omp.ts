/**
 * OmpUnionSessionPersistence — the profile's `sessionPersistence` service.
 *
 * Phase C end-state: OMP's native store (`$OMP_HOME/agent/sessions`) is the
 * ONLY transcript of record. Every read (list, cold history, resume seed,
 * raw export) is served by scanning that store and replaying the OMP
 * transcript into Dash `SessionEvent`s on demand, memoized per file keyed on
 * (size, mtime). There is deliberately NO Dash-side session.jsonl backend
 * anymore: it duplicated OMP's transcript and could drift from it after every
 * wrapper restart. Live sessions stream their events through the in-memory
 * `Session` (`ctx.sessions`); when they go cold the replay takes over again.
 *
 * The write path is therefore a pair of no-ops — persistence durability is
 * OMP's job, and Dash's projection cache (titles/stats in session.list and
 * history) folds off the events this service returns and checkpoints live
 * sessions itself. Legacy jsonl logs from earlier phases stay on disk
 * untouched but are never read or written.
 *
 * dev_0.0.3 §11: every id this service hands upstream (headers, snapshots,
 * raw exports) is the DASH-facing id (pairing.ts) — OMP ids never leave the
 * bridge. All inbound ids translate back through the same pairing.
 */
import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import {
  SessionPersistence,
  SessionPersistenceRevision,
  type SessionInspection,
  type SessionLocation,
  type SessionPersistenceSnapshot,
  type SessionRawArtifact,
} from "@deepseek-ai/dsh-session-persistence";

import {
  SESSION_FORMAT_VERSION,
  SessionId,
  SessionPreparation,
  type SessionEvent,
  type SessionHeader,
} from "@deepseek-ai/dsh-session";
import { readOmpMessages, scanOmpSessions, type OmpNativeSession } from "./omp-store.js";
import { replayOmpTranscript } from "./replay.js";
import { dashIdOf, resolveEntryById } from "./pairing.js";
import { supervisor } from "./supervisor.js";
import { isPresetName, permissionEventsFor, readWebuiPreset, statWebuiArtifact, type WebuiStat } from "./permission.js";

/** The slice of `ctx.sessionProjectionCache` the boot warm pass reads. */
interface ProjectionCacheSlice {
  coldSnapshot(id: SessionId, signal?: AbortSignal): Promise<unknown>;
}

/** Memoized replayed Dash logs, keyed by session file path + (size, mtime) of the transcript and the webui.json artifact. */
const logCache = new Map<string, { size: number; mtimeMs: number; webui: WebuiStat | undefined; events: SessionEvent[] }>();

/** Structural compare of two optional stat tokens. */
function sameStat(left: WebuiStat | undefined, right: WebuiStat | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.size === right.size && left.mtimeMs === right.mtimeMs;
}

export class OmpUnionSessionPersistence extends SessionPersistence {
  readonly supportsRawArtifacts = true;

  constructor(ctx: Context) {
    super(ctx);
    this.warmProjectionCacheOnce();
  }

  /**
   * One-shot boot pass: pre-fill the host's durable projection rows (sidebar
   * titles/stats) for every scanned session under its DASH id, so the first
   * WebUI landing renders real titles instead of cwd-basename fallbacks —
   * rows grouped under one workspace would otherwise all show the same path
   * name. No periodic repeat: titles self-heal through the cold-read ladder
   * when a session is opened, and replaying every changed transcript on a
   * timer is churn the self-heal makes unnecessary.
   */
  private warmProjectionCacheOnce(): void {
    this.ctx.inject(["sessionProjectionCache"], (warmCtx) => {
      const cache = warmCtx.get("sessionProjectionCache") as ProjectionCacheSlice | undefined;
      if (cache === undefined) return;
      void (async () => {
        for (const entry of scanOmpSessions().values()) {
          try {
            await cache.coldSnapshot(SessionId(dashIdOf(entry)));
          } catch {
            // Fail-soft per session: an unreadable transcript degrades that
            // row's projections until opened, never the boot.
          }
        }
      })();
    });
  }

  /** The scanned entry a Dash-facing id resolves to, when the store owns it. */
  private nativeOf(id: string): OmpNativeSession | undefined {
    return resolveEntryById(id);
  }

  /** Dash header for one scanned-native session. */
  private headerOf(entry: OmpNativeSession): SessionHeader {
    return Object.freeze({
      version: SESSION_FORMAT_VERSION,
      id: SessionId(dashIdOf(entry)),
      createdAt: entry.createdAt,
      // The chat-header preset badge resolves session.header.agentPreset
      // (or a later agent-preset/selected event). OMP is single-mode, so every
      // scanned session carries the one hardcoded preset, rendering "OMP"
      // beside the session title exactly like a native Dash session.
      agentPreset: "omp",
      ...(entry.cwd === undefined ? {} : { cwd: entry.cwd }),
    });
  }

  /**
   * The full replayed Dash event log for one scanned-native session
   * (memoized on the transcript's (size, mtime) plus the webui.json
   * artifact's). When the bridge persisted a permission preset for the
   * session, the three Dash permission events are synthesized at the HEAD
   * of the stream — OMP's transcript never records them, so without this a
   * wrapper restart would leave the UI showing no (or the default)
   * permission for the session. Seqs stay contiguous from 0.
   */
  private eventsOf(entry: OmpNativeSession): SessionEvent[] {
    let size: number;
    let mtimeMs: number;
    try {
      const stats = statSync(entry.ompSessionFile);
      size = stats.size;
      mtimeMs = stats.mtimeMs;
    } catch {
      return [];
    }
    const webui = statWebuiArtifact(entry.ompSessionFile);
    const cached = logCache.get(entry.ompSessionFile);
    if (
      cached !== undefined &&
      cached.size === size &&
      cached.mtimeMs === mtimeMs &&
      sameStat(cached.webui, webui)
    ) {
      return cached.events;
    }
    const replayed = replayOmpTranscript(readOmpMessages(entry.ompSessionFile), entry.title, entry.createdAt);
    const preset = webui === undefined ? undefined : readWebuiPreset(entry.ompSessionFile);
    const events =
      preset !== undefined && isPresetName(preset)
        ? [...permissionEventsFor(preset, entry.createdAt), ...replayed].map((event, index) => ({
            ...event,
            seq: index,
          }))
        : replayed;
    logCache.set(entry.ompSessionFile, { size, mtimeMs, webui, events });
    return events;
  }

  /** Resolve an id to its scanned entry, or reject as not found. */
  private requireNative(id: SessionId): OmpNativeSession {
    const entry = this.nativeOf(id as string);
    if (entry === undefined) throw new Error(`session "${id}" not found in the OMP session store`);
    return entry;
  }

  locate(meta: SessionHeader): SessionLocation | undefined {
    const entry = this.nativeOf(meta.id as string);
    return entry === undefined ? undefined : { kind: "omp-jsonl", path: entry.ompSessionFile };
  }

  async list(signal?: AbortSignal): Promise<SessionHeader[]> {
    signal?.throwIfAborted();
    // Dash-facing ids only: bridge sessions list under their real Dash id
    // (so the live row and this cold row are the SAME id and upstream's
    // attached-filter folds them), everything else under its derived id.
    return [...scanOmpSessions().values()].map((entry) => this.headerOf(entry));
  }

  async listSnapshots(signal?: AbortSignal): Promise<SessionPersistenceSnapshot[]> {
    signal?.throwIfAborted();
    return [...scanOmpSessions().values()].map((entry) => ({
      header: this.headerOf(entry),
      revision: SessionPersistenceRevision(entry.revision),
    }));
  }

  /** No-op: OMP owns durability; the transcript materializes on OMP's first write. */
  async create(_meta: SessionHeader): Promise<void> {}

  /** No-op: live events live in the in-memory Session; cold reads replay OMP's file. */
  async append(_id: SessionId, _events: readonly SessionEvent[]): Promise<void> {}

  async load(id: SessionId): Promise<SessionInspection> {
    const entry = this.requireNative(id);
    return { meta: this.headerOf(entry), events: this.eventsOf(entry) };
  }

  async inspect(id: SessionId, signal?: AbortSignal): Promise<SessionInspection> {
    signal?.throwIfAborted();
    supervisor.noteView(String(id));
    return this.load(id);
  }

  async readFrom(id: SessionId, fromSeq: number, signal?: AbortSignal): Promise<{ meta: SessionHeader; events: SessionEvent[] }> {
    signal?.throwIfAborted();
    const entry = this.requireNative(id);
    return { meta: this.headerOf(entry), events: this.eventsOf(entry).filter((event) => event.seq >= fromSeq) };
  }

  async prepare(id: SessionId, signal?: AbortSignal): Promise<SessionPreparation> {
    signal?.throwIfAborted();
    const entry = this.requireNative(id);
    return SessionPreparation.create(
      this.ctx.sessions.prepare(id, {
        seed: this.eventsOf(entry),
        meta: {
          createdAt: entry.createdAt,
          ...(entry.cwd === undefined ? {} : { cwd: entry.cwd }),
        },
      }),
    );
  }

  async readRaw(id: SessionId, signal?: AbortSignal): Promise<SessionRawArtifact | undefined> {
    signal?.throwIfAborted();
    const entry = this.nativeOf(id as string);
    if (entry === undefined) return undefined;
    return {
      meta: this.headerOf(entry),
      filename: basename(entry.ompSessionFile),
      content: readFileSync(entry.ompSessionFile, "utf8"),
    };
  }
}
