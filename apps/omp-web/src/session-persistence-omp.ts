/**
 * OmpUnionSessionPersistence — the profile's `sessionPersistence` service
 * (dsh-session-persistence v2: handle-based seam, lifecycle-owned writes).
 *
 * The centralized index (SQLite) is the sole list/id/metadata authority:
 * `list` / `stat` / cold history all resolve through the index (O(1) by dsh
 * id / file), never a full store scan. The OMP native store remains the ONLY
 * transcript of record — cold events replay the OMP JSONL on demand,
 * single per-file `SessionCacheEntry` (L1 parse + L2 replayed/validated
 * events) with single-flight fill, handed to readers as `shared-frozen` values.
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
import { readOmpTranscript, readOmpTranscriptSdk, type OmpModelChange, type OmpTranscript } from "./omp-store.js";
import type { OmpMessage } from "./rpc-types.js";
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

/** Content cursor: how far into the transcript this entry has ingested. */
export interface SessionCacheCursor {
  lastSeq: number;
  size: number;
  mtimeMs: number;
}

/** One transcript file's staged parse: L1 raw messages, L2 replayed events. */
export interface SessionCacheEntry {
  size: number;
  mtimeMs: number;
  preset: string | null;
  /** L1: raw transcript messages (SDK or JSONL fallback). */
  messages: OmpMessage[];
  /** L2: replayed + validated + frozen Dash event log. */
  events: SessionEvent[];
  /** Ingest cursor (lastSeq/size/mtime) — moved from the supervisor's Entry. */
  cursor: SessionCacheCursor;
}

/** THE single cache map for parsed transcript data, keyed by file path. */
const sessionCache = new Map<string, SessionCacheEntry>();

/** In-flight fills keyed by file path — concurrent opens share ONE parse. */
const inflightFills = new Map<string, Promise<SessionEvent[]>>();

/** Diagnostic parse trace (set OMP_TRACE=1 on the dsh process to enable). */
const TRACE = process.env.OMP_TRACE === "1";
let parseSeq = 0;
const traceParse = (file: string): void => {
  parseSeq += 1;
  if (TRACE) process.stderr.write(`[omp-cache ${Date.now() % 1_000_000}] parse ${file} (seq ${parseSeq})\n`);
};

/** Test/diagnostic seam: total completed parses since process start. */
export function getParseCount(): number {
  return parseSeq;
}

/** The L1 transcript reader: SDK-first, JSONL fallback. Injectable for tests. */
type TranscriptReader = (file: string) => Promise<OmpTranscript>;

const defaultReader: TranscriptReader = async (file) =>
  (await readOmpTranscriptSdk(file)) ?? readOmpTranscript(file);

/** Inputs for one unified {@link SessionCacheEntry} fill. */
export interface SessionCacheFill {
  file: string;
  preset: string | null;
  title?: string;
  createdAt: number;
  header: SessionHeader;
  logger: { warn: (message: string) => void };
  /** L1 reader override (tests); defaults to SDK-first + JSONL fallback. */
  readTranscript?: TranscriptReader;
}

/**
 * The unified fill path for one transcript file (L1 parse → L2 replay) behind
 * ONE cache map with a single-flight guard: concurrent callers of the same
 * file share one parse; every `(size, mtime, preset)` state parses once.
 */
export async function eventsForSessionCache(fill: SessionCacheFill): Promise<SessionEvent[]> {
  const { file, preset, title, createdAt, header, logger, readTranscript = defaultReader } = fill;
  let size: number;
  let mtimeMs: number;
  try {
    const stats = statSync(file);
    size = stats.size;
    mtimeMs = stats.mtimeMs;
  } catch {
    return [];
  }
  const cached = sessionCache.get(file);
  if (cached !== undefined && cached.size === size && cached.mtimeMs === mtimeMs && cached.preset === preset) {
    return cached.events;
  }
  const pending = inflightFills.get(file);
  if (pending !== undefined) return pending;
  const run = fillSessionCacheEntry(file, preset, title, createdAt, header, logger, readTranscript, size, mtimeMs);
  inflightFills.set(file, run);
  try {
    return await run;
  } finally {
    if (inflightFills.get(file) === run) inflightFills.delete(file);
  }
}

function stageSessionCacheEntry(
  file: string,
  preset: string | null,
  title: string | undefined,
  createdAt: number,
  header: SessionHeader,
  logger: { warn: (message: string) => void },
  messages: OmpMessage[],
  modelChanges: OmpModelChange[],
  size: number,
  mtimeMs: number,
): SessionEvent[] {
  traceParse(file);
  const replayed = replayOmpTranscript(messages, title, createdAt, modelChanges);
  const events =
    preset !== undefined && isPresetName(preset)
      ? [...permissionEventsFor(preset, createdAt), ...replayed].map((event, index) => ({ ...event, seq: SessionSeq(index) }))
      : replayed;
  let stored: SessionEvent[];
  try {
    stored = validateStoredEvents(header, events);
    assertContiguous(header.id, stored, 0);
  } catch (error) {
    // A malformed replay degrades that file's reads to an empty log until its
    // (size, mtime) changes — fail-soft, never the caller's boot/tick.
    logger.warn(`omp persistence: replay of "${file}" failed storage validation; serving empty log (${String(error)})`);
    stored = [];
  }
  sessionCache.set(file, { size, mtimeMs, preset, messages, events: stored, cursor: { lastSeq: stored.length, size, mtimeMs } });
  return stored;
}

async function fillSessionCacheEntry(
  file: string,
  preset: string | null,
  title: string | undefined,
  createdAt: number,
  header: SessionHeader,
  logger: { warn: (message: string) => void },
  readTranscript: TranscriptReader,
  size: number,
  mtimeMs: number,
): Promise<SessionEvent[]> {
  const { messages, modelChanges } = await readTranscript(file);
  return stageSessionCacheEntry(file, preset, title, createdAt, header, logger, messages, modelChanges, size, mtimeMs);
}

/** Read the live cache entry for a file (supervisor cursor access). */
export function sessionCacheEntryOf(file: string): SessionCacheEntry | undefined {
  return sessionCache.get(file);
}

/**
 * The full replayed event log for a file (supervisor-facing). Resolves the
 * index row when present for title/preset/header; otherwise synthesizes a
 * minimal header from `id` so the fill still works before a row exists.
 * Shares the one {@link SessionCacheEntry} fill path (single-flight).
 */
export async function eventsForSessionFile(
  file: string,
  id: string,
  logger: { warn: (message: string) => void },
): Promise<SessionEvent[]> {
  const row = getBridgeStore()?.byFile(file);
  return eventsForSessionCache({
    file,
    preset: row?.permission_preset ?? null,
    title: row?.title ?? undefined,
    createdAt: row?.created_at ?? 0,
    header: row === undefined ? sessionHeaderForId(id) : sessionHeaderOf(row),
    logger,
  });
}

export function fillSessionCacheEntrySync(file: string, id: string, logger: { warn: (message: string) => void }): SessionEvent[] {
  let size: number;
  let mtimeMs: number;
  try {
    const stats = statSync(file);
    size = stats.size;
    mtimeMs = stats.mtimeMs;
  } catch {
    return [];
  }
  const row = getBridgeStore()?.byFile(file);
  const preset = row?.permission_preset ?? null;
  const cached = sessionCache.get(file);
  if (cached !== undefined && cached.size === size && cached.mtimeMs === mtimeMs && cached.preset === preset) {
    return cached.events;
  }
  const { messages, modelChanges } = readOmpTranscript(file);
  const header = row === undefined ? sessionHeaderForId(id) : sessionHeaderOf(row);
  return stageSessionCacheEntry(file, preset, row?.title ?? undefined, row?.created_at ?? 0, header, logger, messages, modelChanges, size, mtimeMs);
}

/**
 * The supervisor's synchronous incremental ingest: stat the file against the
 * entry's cursor and, on growth, re-fill (sync JSONL) and return ONLY the
 * delta events past `cursor.lastSeq`. The fill advances the entry's cursor and
 * swaps in the new frozen `events` array, so a teardown → cold-read with no
 * further change re-serves the entry without a re-parse.
 */
export function ingestSessionFileGrowthSync(file: string, id: string, logger: { warn: (message: string) => void }): SessionEvent[] {
  const cached = sessionCache.get(file);
  const cursor = cached?.cursor;
  if (cursor === undefined) return [];
  let size: number;
  let mtimeMs: number;
  try {
    const stats = statSync(file);
    size = stats.size;
    mtimeMs = stats.mtimeMs;
  } catch {
    return [];
  }
  if (size === cursor.size && mtimeMs === cursor.mtimeMs) return [];
  const events = fillSessionCacheEntrySync(file, id, logger);
  return events.slice(cursor.lastSeq);
}

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

/** Dash header for one indexed session (v2: `isSeeded` always false). */
function sessionHeaderOf(row: SessionRow): SessionHeader {
  return Object.freeze({
    version: SESSION_FORMAT_VERSION,
    id: SessionId(row.dsh_session_id),
    createdAt: row.created_at,
    isSeeded: false,
    agentPreset: row.agent_preset ?? "omp",
    ...(row.cwd === null ? {} : { cwd: row.cwd }),
  });
}

/** A minimal header synthesized when a file is not (yet) in the index. */
function sessionHeaderForId(id: string): SessionHeader {
  return Object.freeze({
    version: SESSION_FORMAT_VERSION,
    id: SessionId(id),
    createdAt: 0,
    isSeeded: false,
    agentPreset: "omp",
  });
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
            await cache.coldSnapshot(this.headerOf(row), SessionLogOffset(0), await this.eventsOf(row));
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

  private headerOf(row: SessionRow): SessionHeader {
    return sessionHeaderOf(row);
  }

  private revisionOf(row: SessionRow) {
    return SessionPersistenceRevision(`omp:${row.transcript_size}:${row.last_modified_at}`);
  }

  /**
   * The full replayed Dash event log for one indexed session, served from the
   * unified {@link SessionCacheEntry} store (L1 parse + L2 replay behind one
   * map, single-flight). See {@link eventsForSessionCache}.
   */
  private async eventsOf(row: SessionRow): Promise<SessionEvent[]> {
    return eventsForSessionCache({
      file: row.session_file,
      preset: row.permission_preset,
      title: row.title ?? undefined,
      createdAt: row.created_at,
      header: this.headerOf(row),
      logger: this.ctx.logger,
    });
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
    return new OmpSessionHandle(this.headerOf(row), access, await this.eventsOf(row));
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
