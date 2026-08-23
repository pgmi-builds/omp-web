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
import { sessionIndex } from "./session-index.js";
import { readOmpMessages, scanOmpSessions, type OmpNativeSession } from "./omp-store.js";
import { replayOmpTranscript } from "./replay.js";
import { isPresetName, permissionEventsFor, readWebuiPreset, statWebuiArtifact, type WebuiStat } from "./permission.js";
/** The slice of `ctx.sessionProjectionCache` the list-title warm path reads. */
interface ProjectionCacheSlice {
  coldSnapshot(id: SessionId, signal?: AbortSignal): Promise<unknown>;
}



/** How often the projection-cache warm pass rescans for changed transcripts. */
const WARM_INTERVAL_MS = 60_000;

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
    void this.seedSessionIndex();
    this.warmProjectionCache();
  }

  /** Idempotently seed the Dash→OMP resume index for scanned-native sessions. */
  private async seedSessionIndex(): Promise<void> {
    const known = sessionIndex.load();
    for (const entry of scanOmpSessions().values()) {
      if (known[entry.ompSessionId] !== undefined) continue;
      await sessionIndex.put(entry.ompSessionId, {
        ompSessionId: entry.ompSessionId,
        ompSessionFile: entry.ompSessionFile,
        ...(entry.cwd === undefined ? {} : { cwd: entry.cwd }),
        createdAt: entry.createdAt,
      });
    }
  }

  /**
   * Warm the host's persisted projection cache for scanned-native sessions so
   * `session.list` rows carry their `title` (and stats) projections from the
   * first listing, without each row having been opened once. `coldSnapshot`
   * reads through THIS service (replay) and writes the durable row itself.
   * The pass repeats on a timer but only re-reads sessions whose transcript
   * changed since the last pass (the scan's size+mtime revision token), so
   * TUI-created or TUI-extended sessions pick up list titles within a minute.
   * Sequential and fail-soft per session.
   */
  private warmProjectionCache(): void {
    this.ctx.inject(["sessionProjectionCache"], (warmCtx) => {
      const cache = warmCtx.get("sessionProjectionCache") as ProjectionCacheSlice | undefined;
      if (cache === undefined) return;
      const warmed = new Map<string, string>();
      const pass = async (): Promise<void> => {
        for (const entry of scanOmpSessions().values()) {
          if (warmed.get(entry.ompSessionFile) === entry.revision) continue;
          try {
            await cache.coldSnapshot(SessionId(entry.ompSessionId));
            warmed.set(entry.ompSessionFile, entry.revision);
          } catch {
            // Fail-soft per session: an unreadable transcript degrades its
            // list row's projections, never the boot.
          }
        }
      };
      void pass();
      warmCtx.effect(() => {
        const timer = setInterval(() => void pass(), WARM_INTERVAL_MS);
        timer.unref?.();
        return () => clearInterval(timer);
      }, "ompProvider.projectionWarmTimer");
    });
  }

  /** The scanned entry for an id, when OMP's store owns it. */
  private nativeOf(id: string): OmpNativeSession | undefined {
    return scanOmpSessions().get(id);
  }

  /** Dash header for one scanned-native session. */
  private headerOf(entry: OmpNativeSession): SessionHeader {
    return Object.freeze({
      version: SESSION_FORMAT_VERSION,
      id: SessionId(entry.ompSessionId),
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
