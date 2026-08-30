/**
 * OmpUnionSessionPersistence — the profile's `sessionPersistence` service.
 *
 * The centralized index (SQLite) is the sole list/id/metadata authority:
 * `list` / `listSnapshots` / cold history / resume seed all read the index
 * (O(1) by dsh id / file), never a full store scan. The OMP native store
 * remains the ONLY transcript of record — cold events replay the OMP JSONL
 * on demand, memoized per file keyed on (size, mtime, preset).
 *
 * dev_0.0.3 §11: every id this service hands upstream (headers, snapshots,
 * raw exports) is the DASH-facing id (the index's `dsh_session_id`) — OMP ids
 * never leave the bridge.
 */
import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import {
  SessionPersistence,
  SessionPersistenceNotFoundError,
  SessionPersistenceRevision,
  type BorrowedSessionSource,
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
import { readOmpMessages } from "./omp-store.js";
import { replayOmpTranscript } from "./replay.js";
import { supervisor } from "./supervisor.js";
import { isPresetName, permissionEventsFor } from "./permission.js";
import { getBridgeStore } from "./store/index.js";
import type { SessionRow } from "./store/db.js";

/** The slice of `ctx.sessionProjectionCache` the boot warm pass reads. */
interface ProjectionCacheSlice {
  coldSnapshot(id: SessionId, signal?: AbortSignal): Promise<unknown>;
}

/** Memoized replayed Dash logs, keyed by file + (size, mtime, preset). */
const logCache = new Map<string, { size: number; mtimeMs: number; preset: string | null; events: SessionEvent[] }>();

export class OmpUnionSessionPersistence extends SessionPersistence {
  readonly supportsRawArtifacts = true;

  constructor(ctx: Context) {
    super(ctx);
    this.warmProjectionCacheOnce();
  }

  /**
   * One-shot boot pass: pre-fill the host's durable projection rows (sidebar
   * titles/stats) for every indexed session under its DASH id, so the first
   * WebUI landing renders real titles instead of cwd-basename fallbacks.
   */
  private warmProjectionCacheOnce(): void {
    this.ctx.inject(["sessionProjectionCache"], (warmCtx) => {
      const cache = warmCtx.get("sessionProjectionCache") as ProjectionCacheSlice | undefined;
      if (cache === undefined) return;
      void (async () => {
        const store = getBridgeStore();
        if (store === undefined) return;
        for (const row of store.list()) {
          try {
            await cache.coldSnapshot(SessionId(row.dsh_session_id));
          } catch {
            // Fail-soft per session: an unreadable transcript degrades that
            // row's projections until opened, never the boot.
          }
        }
      })();
    });
  }

  /** The index row a Dash-facing id resolves to, or throw not-found. */
  private requireRow(id: SessionId): SessionRow {
    const row = getBridgeStore()?.byDshId(id as string);
    if (row === undefined) throw new SessionPersistenceNotFoundError(id);
    return row;
  }

  /** Dash header for one indexed session. */
  private headerOf(row: SessionRow): SessionHeader {
    return Object.freeze({
      version: SESSION_FORMAT_VERSION,
      id: SessionId(row.dsh_session_id),
      createdAt: row.created_at,
      // OMP is single-mode: every session carries the one hardcoded preset
      // (the index stores it; fall back defensively).
      agentPreset: row.agent_preset ?? "omp",
      ...(row.cwd === null ? {} : { cwd: row.cwd }),
    });
  }

  /**
   * The full replayed Dash event log for one indexed session (memoized on
   * (size, mtime, preset)). When the index records a permission preset, the
   * three Dash permission events are synthesized at the HEAD — OMP's
   * transcript never records them.
   */
  private eventsOf(row: SessionRow): SessionEvent[] {
    let size: number;
    let mtimeMs: number;
    try {
      const stats = statSync(row.session_file);
      size = stats.size;
      mtimeMs = stats.mtimeMs;
    } catch {
      return [];
    }
    const preset = row.permission_preset;
    const cached = logCache.get(row.session_file);
    if (cached !== undefined && cached.size === size && cached.mtimeMs === mtimeMs && cached.preset === preset) {
      return cached.events;
    }
    const replayed = replayOmpTranscript(readOmpMessages(row.session_file), row.title ?? undefined, row.created_at);
    const events =
      preset !== undefined && isPresetName(preset)
        ? [...permissionEventsFor(preset, row.created_at), ...replayed].map((event, index) => ({
            ...event,
            seq: index,
          }))
        : replayed;
    logCache.set(row.session_file, { size, mtimeMs, preset, events });
    return events;
  }

  /** Unpublished Sessions pinned by an outstanding cold {@link borrowSession}. */
  private borrowedPins = new Map<string, { preparation: SessionPreparation; refs: number }>();

  locate(meta: SessionHeader): SessionLocation | undefined {
    const row = getBridgeStore()?.byDshId(meta.id as string);
    return row === undefined ? undefined : { kind: "omp-jsonl", path: row.session_file };
  }

  async list(signal?: AbortSignal): Promise<SessionHeader[]> {
    signal?.throwIfAborted();
    const store = getBridgeStore();
    if (store === undefined) return [];
    // Default list excludes archived sessions (their rows stay for restore).
    return store.list().filter((row) => row.archived === 0).map((row) => this.headerOf(row));
  }

  async listSnapshots(signal?: AbortSignal): Promise<SessionPersistenceSnapshot[]> {
    signal?.throwIfAborted();
    const store = getBridgeStore();
    if (store === undefined) return [];
    return store
      .list()
      .filter((row) => row.archived === 0)
      .map((row) => ({
        header: this.headerOf(row),
        revision: SessionPersistenceRevision(`omp:${row.transcript_size}:${row.last_modified_at}`),
      }));
  }

  /** No-op: OMP owns durability; the transcript materializes on OMP's first write. */
  async create(_meta: SessionHeader): Promise<void> {}

  /** No-op: live events live in the in-memory Session; cold reads replay OMP's file. */
  async append(_id: SessionId, _events: readonly SessionEvent[]): Promise<void> {}

  async load(id: SessionId): Promise<SessionInspection> {
    const row = this.requireRow(id);
    return { meta: this.headerOf(row), events: this.eventsOf(row) };
  }

  async inspect(id: SessionId, signal?: AbortSignal): Promise<SessionInspection> {
    signal?.throwIfAborted();
    supervisor.noteView(String(id));
    getBridgeStore()?.touchVisited(String(id), Date.now());
    return this.load(id);
  }

  async borrowSession(id: SessionId, signal?: AbortSignal): Promise<BorrowedSessionSource> {
    signal?.throwIfAborted();
    const live = this.ctx.sessions.get(id);
    if (live !== undefined) {
      return {
        source: "live",
        inspection: { meta: live.header, events: live.events },
        [Symbol.dispose]() {},
      };
    }
    supervisor.noteView(String(id));
    getBridgeStore()?.touchVisited(String(id), Date.now());
    const row = this.requireRow(id);
    let pin = this.borrowedPins.get(id as string);
    if (pin === undefined) {
      pin = { preparation: await this.prepare(id, signal), refs: 0 };
      this.borrowedPins.set(id as string, pin);
    }
    pin.refs += 1;
    const current = pin;
    return {
      source: "prepared",
      inspection: { meta: this.headerOf(row), events: this.eventsOf(row) },
      revision: SessionPersistenceRevision(`omp:${row.transcript_size}:${row.last_modified_at}`),
      preparedSession: current.preparation.session,
      [Symbol.dispose]: () => {
        current.refs -= 1;
        if (current.refs === 0 && this.borrowedPins.get(id as string) === current) {
          this.borrowedPins.delete(id as string);
        }
      },
    };
  }

  async readFrom(id: SessionId, fromSeq: number, signal?: AbortSignal): Promise<{ meta: SessionHeader; events: SessionEvent[] }> {
    signal?.throwIfAborted();
    const row = this.requireRow(id);
    return { meta: this.headerOf(row), events: this.eventsOf(row).filter((event) => event.seq >= fromSeq) };
  }

  async prepare(id: SessionId, signal?: AbortSignal): Promise<SessionPreparation> {
    signal?.throwIfAborted();
    // A pinned borrow hands its exact unpublished Session to the resume path.
    const pinned = this.borrowedPins.get(id as string);
    if (pinned !== undefined) {
      this.borrowedPins.delete(id as string);
      return pinned.preparation;
    }
    const row = this.requireRow(id);
    return SessionPreparation.create(
      this.ctx.sessions.prepare(id, {
        seed: this.eventsOf(row),
        meta: {
          createdAt: row.created_at,
          ...(row.cwd === null ? {} : { cwd: row.cwd }),
        },
      }),
    );
  }

  async readRaw(id: SessionId, signal?: AbortSignal): Promise<SessionRawArtifact | undefined> {
    signal?.throwIfAborted();
    const row = getBridgeStore()?.byDshId(id as string);
    if (row === undefined) return undefined;
    return {
      meta: this.headerOf(row),
      filename: basename(row.session_file),
      content: readFileSync(row.session_file, "utf8"),
    };
  }
}
