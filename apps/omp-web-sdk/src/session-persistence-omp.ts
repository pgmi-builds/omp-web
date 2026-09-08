/**
 * OmpUnionSessionPersistence — the profile's `sessionPersistence` service
 * (dsh-session-persistence v2: handle-based seam, lifecycle-owned writes).
 *
 * The centralized index (SQLite) is the sole list/id/metadata authority:
 * `list` / `stat` / cold history all resolve through the index (O(1) by dsh
 * id / file), never a full store scan. The OMP native store remains the ONLY
 * transcript of record — cold events replay the OMP JSONL on demand,
 * memoized per file keyed on (size, mtime, preset), validated and frozen at
 * fill time, and handed to readers as `shared-frozen` values.
 *
 * Writes: OMP owns physical durability. `create` / `open(id, "write")`
 * return handles whose appends buffer in memory only — enough for
 * in-process consumers (e.g. feedback) that append under the v2 seam —
 * and `flush` materializes nothing. The bridge never writes the
 * transcript; the next reconcile pass re-reads OMP's file as the record.
 *
 * dev_0.0.3 §11: every id this service hands upstream (headers, snapshots)
 * is the DASH-facing id (the index's `dsh_session_id`) — OMP ids never
 * leave the bridge.
 */
import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import {
  SessionPersistence,
  SessionHandleClosedError,
  SessionPersistenceNotFoundError,
  SessionReadOnlyError,
  SessionPersistenceRevision,
  assertContiguous,
  validateStoredEvents,
  type SessionAccess,
  type SessionHandle,
  type SessionHandleReadOptions,
  type SessionHandleReadResult,
  type SessionPersistenceCreateOptions,
  type SessionPersistenceListOptions,
  type SessionPersistenceOpenOptions,
  type SessionPersistenceSnapshot,
  type SessionPersistenceStatOptions,
} from "@deepseek-ai/dsh-session-persistence";
import {
  SESSION_FORMAT_VERSION,
  SessionId,
  SessionLogOffset,
  SessionSeq,
  type SessionEvent,
  type SessionHeader,
} from "@deepseek-ai/dsh-session";
import { readOmpTranscript } from "./omp-store.js";
import { replayOmpTranscript } from "./replay.js";
import { supervisor } from "./supervisor.js";
import { isPresetName, permissionEventsFor } from "./permission.js";
import { getBridgeStore } from "./store/index.js";
import type { SessionRow } from "./store/db.js";

/** The slice of `ctx.sessionProjectionCache` the boot warm pass reads. */
interface ProjectionCacheSlice {
  coldSnapshot(
    meta: SessionHeader,
    inheritedEventCount: SessionLogOffset,
    events: readonly SessionEvent[],
  ): Promise<unknown>;
}

/** Memoized replayed Dash logs, keyed by file + (size, mtime, preset). */
const logCache = new Map<string, { size: number; mtimeMs: number; preset: string | null; events: SessionEvent[] }>();

/**
 * One open channel onto an OMP-indexed session's replayed log. Read handles
 * serve contiguous slices of the validated replay; write handles buffer
 * appends in memory (OMP owns physical durability) and read their own
 * appends back per the v2 freshness contract.
 */
class OmpSessionHandle implements SessionHandle {
  readonly id: SessionId;
  readonly header: SessionHeader;
  readonly inheritedEventCount: SessionLogOffset = SessionLogOffset(0);
  readonly access: SessionAccess;
  /** Base log captured at open; validated + frozen, never mutated after. */
  readonly #base: readonly SessionEvent[];
  readonly #buffer: SessionEvent[] = [];
  #closed = false;

  constructor(header: SessionHeader, access: SessionAccess, base: readonly SessionEvent[]) {
    this.id = header.id;
    this.header = header;
    this.access = access;
    this.#base = base;
  }

  #assertOpen(operation: string): void {
    if (this.#closed) throw new SessionHandleClosedError(this.id, operation);
  }

  async read(offset = 0, length?: number, options?: SessionHandleReadOptions): Promise<SessionHandleReadResult> {
    this.#assertOpen("read");
    options?.signal?.throwIfAborted();
    const log = [...this.#base, ...this.#buffer];
    const start = Math.max(0, Math.min(offset, log.length));
    const end = length === undefined ? log.length : Math.min(offset + Math.max(0, length), log.length);
    return { eventState: "shared-frozen", events: log.slice(start, end) };
  }

  async append(events: readonly SessionEvent[]): Promise<void> {
    this.#assertOpen("append");
    if (this.access !== "write") throw new SessionReadOnlyError(this.id, "append");
    assertContiguous(this.id, events, this.#base.length + this.#buffer.length);
    this.#buffer.push(...events);
  }

  async flush(): Promise<void> {
    this.#assertOpen("flush");
    if (this.access !== "write") throw new SessionReadOnlyError(this.id, "flush");
    // Materialize-if-needed: nothing to materialize — OMP owns durability and
    // the bridge never writes the transcript.
  }

  async close(): Promise<void> {
    this.#closed = true;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}

export class OmpUnionSessionPersistence extends SessionPersistence {
  constructor(ctx: Context) {
    super(ctx);
    this.warmProjectionCacheOnce();
  }

  /**
   * One-shot boot pass: pre-fill the host's durable projection rows (sidebar
   * titles/stats) for every indexed session under its DASH id, so the first
   * WebUI landing renders real titles instead of cwd-basename fallbacks.
   * Calls the projection cache directly with the replayed log — deliberately
   * NOT through `open`, so boot warming never counts as "viewed".
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
            await cache.coldSnapshot(this.headerOf(row), SessionLogOffset(0), this.eventsOf(row));
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

  /** Dash header for one indexed session (v2: `isSeeded` always false). */
  private headerOf(row: SessionRow): SessionHeader {
    return Object.freeze({
      version: SESSION_FORMAT_VERSION,
      id: SessionId(row.dsh_session_id),
      createdAt: row.created_at,
      isSeeded: false,
      // OMP is single-mode: every session carries the one hardcoded preset
      // (the index stores it; fall back defensively).
      agentPreset: row.agent_preset ?? "omp",
      ...(row.cwd === null ? {} : { cwd: row.cwd }),
    });
  }

  private revisionOf(row: SessionRow) {
    return SessionPersistenceRevision(`omp:${row.transcript_size}:${row.last_modified_at}`);
  }

  /**
   * The full replayed Dash event log for one indexed session (memoized on
   * (size, mtime, preset)), run through the shared storage validation and
   * frozen so read handles may label it `shared-frozen`. When the index
   * records a permission preset, the three Dash permission events are
   * synthesized at the HEAD — OMP's transcript never records them.
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
    const { messages, modelChanges } = readOmpTranscript(row.session_file);
    const replayed = replayOmpTranscript(messages, row.title ?? undefined, row.created_at, modelChanges);
    const events =
      preset !== undefined && isPresetName(preset)
        ? [...permissionEventsFor(preset, row.created_at), ...replayed].map((event, index) => ({
            ...event,
            seq: SessionSeq(index),
          }))
        : replayed;
    let stored: SessionEvent[];
    try {
      stored = validateStoredEvents(this.headerOf(row), events);
      assertContiguous(this.headerOf(row).id, stored, 0);
    } catch (error) {
      // A malformed replay degrades that file's cold reads to an empty log
      // until its (size, mtime) changes — fail-soft, never the caller's boot.
      this.ctx.logger.warn(
        `omp persistence: replay of "${row.session_file}" failed storage validation; serving empty log (${String(error)})`,
      );
      stored = [];
    }
    logCache.set(row.session_file, { size, mtimeMs, preset, events: stored });
    return stored;
  }

  async list(options?: SessionPersistenceListOptions): Promise<readonly SessionPersistenceSnapshot[]> {
    options?.signal?.throwIfAborted();
    const store = getBridgeStore();
    if (store === undefined) return [];
    // Default list excludes archived sessions (their rows stay for restore).
    return store
      .list()
      .filter((row) => row.archived === 0)
      .map((row) => ({ header: this.headerOf(row), revision: this.revisionOf(row) }));
  }

  async stat(id: SessionId, options?: SessionPersistenceStatOptions): Promise<SessionPersistenceSnapshot | undefined> {
    options?.signal?.throwIfAborted();
    const row = getBridgeStore()?.byDshId(id as string);
    if (row === undefined) return undefined;
    return { header: this.headerOf(row), revision: this.revisionOf(row) };
  }

  async create(header: SessionHeader, options?: SessionPersistenceCreateOptions): Promise<SessionHandle> {
    options?.signal?.throwIfAborted();
    // A Dash-side created session exists only in the live store until OMP
    // materializes its transcript and the index reconciles the row; the
    // in-memory write handle satisfies the lifecycle without duplicating
    // durability OMP already owns.
    return new OmpSessionHandle(header, "write", []);
  }

  async open(id: SessionId, access: SessionAccess, options?: SessionPersistenceOpenOptions): Promise<SessionHandle> {
    options?.signal?.throwIfAborted();
    const row = this.requireRow(id);
    if (access === "read") {
      // A cold read IS the view signal: drives the supervisor's follow loop
      // (foreign-writer detection) and the visited-at bookkeeping.
      supervisor.noteView(String(id));
      getBridgeStore()?.touchVisited(String(id), Date.now());
    }
    return new OmpSessionHandle(this.headerOf(row), access, this.eventsOf(row));
  }

  /** Flush every write handle — a no-op barrier: OMP owns durability. */
  async flush(): Promise<void> {}

  /** Durable raw artifact: the OMP transcript itself (exports/attachments). */
  async readRaw(id: SessionId): Promise<{ meta: SessionHeader; filename: string; content: string } | undefined> {
    const row = getBridgeStore()?.byDshId(id as string);
    if (row === undefined) return undefined;
    return {
      meta: this.headerOf(row),
      filename: basename(row.session_file),
      content: readFileSync(row.session_file, "utf8"),
    };
  }
}
