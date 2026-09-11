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
import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
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
import { OMP_CACHE_DIR, OMP_CACHE_DISK, OMP_CACHE_MAX_BYTES, OMP_CACHE_MAX_ENTRIES } from "./knobs.js";

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
  /** Dash-facing id (the disk-tier filename); set at fill time. */
  dshId: string;
  /** LRU recency proxy (epoch ms): last view OR create OR update in this process. */
  lastViewedAt: number;
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

/** Test/diagnostic seam: total completed parses since process start (a stat-ok-but-empty read counts as one). */
export function getParseCount(): number {
  return parseSeq;
}

// ---------------------------------------------------------------------------
// Disk tier (T17) + bounded-memory LRU (T18) + disk-dir cleanup (T19).
// ---------------------------------------------------------------------------

/** Cache policy: in-memory caps + disk-tier on/off + dir + version resolver. */
export interface CachePolicy {
  maxEntries: number;
  maxBytes: number;
  diskEnabled: boolean;
  diskDir: string;
  ompVersion: () => string;
}

const UNKNOWN_VERSION = "unknown";
const DISK_FLUSH_DELAY_MS = 2_000;

let defaultPolicy: CachePolicy | null = null;

/** Resolve the replay-cache dir exactly the way the bridge store resolves its DB dir. */
function resolveReplayCacheDir(): string {
  const explicit = OMP_CACHE_DIR;
  if (explicit !== undefined && explicit !== "" && !explicit.startsWith("/")) {
    // Fail-soft: a relative override disables the disk tier rather than failing boot.
    process.stderr.write(`[omp-cache] OMP_CACHE_DIR="${explicit}" is not an absolute path — disk replay tier disabled\n`);
    return "";
  }
  return resolve(
    explicit !== undefined && explicit !== ""
      ? explicit
      : join(process.env.DSH_HOME ?? join(homedir(), ".omp", "dsh"), "cache", "replay"),
  );
}

function resolveDefaultPolicy(): CachePolicy {
  if (defaultPolicy === null) {
    defaultPolicy = {
      maxEntries: OMP_CACHE_MAX_ENTRIES,
      maxBytes: OMP_CACHE_MAX_BYTES,
      diskEnabled: OMP_CACHE_DISK,
      diskDir: OMP_CACHE_DISK ? resolveReplayCacheDir() : "",
      ompVersion: memoizedOmpVersion,
    };
  }
  return defaultPolicy;
}

let policyOverride: Partial<CachePolicy> | null = null;

function policy(): CachePolicy {
  if (policyOverride === null) return resolveDefaultPolicy();
  return { ...resolveDefaultPolicy(), ...policyOverride };
}

let ompVersionMemo: string | undefined;

/**
 * The process OMP version, obtained once and memoized. `omp --version` is the
 * authoritative user-facing version (e.g. 18.1.16); the sidecar's `sys.ping.sdk`
 * exposes the embedded SDK LIBRARY version (e.g. 18.1.14) — a different value, so
 * it is not a faithful `ompVersion`. Resolved lazily (only when the disk tier first
 * needs a fingerprint) and synchronously (the fingerprint is also written from the
 * synchronous LRU flush-before-evict path). Any failure resolves to `"unknown"`,
 * which only matches a disk fingerprint that is ALSO `"unknown"` (a fingerprint
 * carrying `"unknown"` is never trusted against a real in-process version).
 */
function memoizedOmpVersion(): string {
  if (ompVersionMemo !== undefined) return ompVersionMemo;
  try {
    const result = spawnSync("omp", ["--version"], { encoding: "utf8", timeout: 3_000 });
    const text = result.error === undefined && result.status === 0 ? (result.stdout ?? "").trim() : "";
    ompVersionMemo = text === "" ? UNKNOWN_VERSION : text;
  } catch {
    ompVersionMemo = UNKNOWN_VERSION;
  }
  return ompVersionMemo;
}

/** The disk file payload: a fingerprint + the replayed/validated event log. */
interface DiskCacheFile {
  fingerprint: {
    size: number;
    mtimeMs: number;
    ompVersion: string;
    preset: string | null;
    formatVersion: number;
  };
  events: SessionEvent[];
}

/** Guard a dash id for use as a filename component (ids are uuids; defensive). */
function safeDiskName(dshId: string): string {
  return dshId.replace(/[^A-Za-z0-9._-]/g, "_");
}

function diskFilePath(dshId: string): string {
  return join(policy().diskDir, `${safeDiskName(dshId)}.json`);
}

// Debounced flush state (dirty files awaiting their next write).
const diskDirty = new Set<string>();
let diskFlushTimer: ReturnType<typeof setTimeout> | null = null;
let swept = false;
/** Diagnostic counter: disk-read attempts in {@link adoptFromDisk} (test seam). */
let diskReadCount = 0;

/** Write one entry to its disk file atomically (tmp + rename). */
function writeDiskEntry(entry: SessionCacheEntry): void {
  const p = policy();
  if (!p.diskEnabled || p.diskDir === "") return;
  ensureDiskSweep();
  const payload: DiskCacheFile = {
    fingerprint: {
      size: entry.size,
      mtimeMs: entry.mtimeMs,
      ompVersion: p.ompVersion(),
      preset: entry.preset,
      formatVersion: SESSION_FORMAT_VERSION,
    },
    events: entry.events,
  };
  try {
    mkdirSync(p.diskDir, { recursive: true }); // whole-directory deletion self-heals here
    const target = diskFilePath(entry.dshId);
    const tmp = `${target}.tmp`;
    writeFileSync(tmp, JSON.stringify(payload));
    renameSync(tmp, target);
  } catch {
    // Non-fatal: the disk tier is a cache; OMP's transcript remains the record of truth.
  }
}

/** Schedule a debounced (~2s) flush of one file after an incremental append. */
function scheduleDiskWrite(file: string): void {
  const p = policy();
  if (!p.diskEnabled || p.diskDir === "") return;
  diskDirty.add(file);
  if (diskFlushTimer !== null) return;
  diskFlushTimer = setTimeout(() => {
    diskFlushTimer = null;
    flushDiskNow();
  }, DISK_FLUSH_DELAY_MS);
  diskFlushTimer.unref?.();
}

/** Flush every dirty file's current entry state to disk (idle-safe). */
function flushDiskNow(): void {
  if (diskFlushTimer !== null) {
    clearTimeout(diskFlushTimer);
    diskFlushTimer = null;
  }
  for (const file of [...diskDirty]) {
    diskDirty.delete(file);
    const entry = sessionCache.get(file);
    if (entry !== undefined) writeDiskEntry(entry);
  }
}

/** Load + re-validate one disk replay; undefined on any mismatch/throw (→ normal fill). */
function adoptFromDisk(
  file: string,
  size: number,
  mtimeMs: number,
  preset: string | null,
  header: SessionHeader,
  dshId: string,
): SessionEvent[] | undefined {
  const p = policy();
  if (!p.diskEnabled || p.diskDir === "") return undefined;
  ensureDiskSweep();
  diskReadCount += 1;
  let raw: string;
  try {
    raw = readFileSync(diskFilePath(dshId), "utf8");
  } catch {
    return undefined;
  }
  let parsed: DiskCacheFile;
  try {
    parsed = JSON.parse(raw) as DiskCacheFile;
  } catch {
    return undefined;
  }
  const fp = parsed?.fingerprint;
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    !Array.isArray(parsed.events) ||
    fp === null ||
    typeof fp !== "object" ||
    fp.size !== size ||
    fp.mtimeMs !== mtimeMs ||
    fp.preset !== preset ||
    fp.formatVersion !== SESSION_FORMAT_VERSION ||
    fp.ompVersion !== p.ompVersion()
  ) {
    return undefined;
  }
  let adopted: SessionEvent[];
  try {
    // Re-validate before trusting: a corrupt-but-fingerprint-matching file must
    // never reach a reader.
    adopted = validateStoredEvents(header, parsed.events);
    assertContiguous(header.id, adopted, 0);
  } catch {
    return undefined;
  }
  // Adopt: L1 (messages) is write-only dead weight, so it starts empty and is
  // re-derived on the next growth ingest.
  storeEntryAndEvict(file, {
    size,
    mtimeMs,
    preset,
    messages: [],
    events: adopted,
    cursor: { lastSeq: adopted.length, size, mtimeMs },
    dshId,
    lastViewedAt: Date.now(),
  });
  return adopted;
}

/** Whether this file's entry must not be evicted (live follow or in-flight fill). */
function isExemptFromEviction(file: string): boolean {
  if (inflightFills.has(file)) return true;
  return supervisor.isFollowed(file);
}

/** Shared store-then-evict: set an entry and enforce caps, protecting it from its own round. */
function storeEntryAndEvict(file: string, entry: SessionCacheEntry): void {
  sessionCache.set(file, entry);
  evictColdest(file);
}

/** Enforce the in-memory caps, coldest first; flush-before-evict, skip exempt entries. */
function evictColdest(protectFile?: string): void {
  const p = policy();
  if (p.maxEntries === 0 && p.maxBytes === 0) return;
  const maxEntries = p.maxEntries === 0 ? Number.POSITIVE_INFINITY : p.maxEntries;
  const maxBytes = p.maxBytes === 0 ? Number.POSITIVE_INFINITY : p.maxBytes;
  const totalBytes = (): number => {
    let bytes = 0;
    for (const entry of sessionCache.values()) bytes += entry.size;
    return bytes;
  };
  if (sessionCache.size <= maxEntries && totalBytes() <= maxBytes) return;
  const candidates = [...sessionCache.entries()]
    .filter(([file]) => file !== protectFile && !isExemptFromEviction(file))
    .sort((a, b) => a[1].lastViewedAt - b[1].lastViewedAt);
  for (const [file, entry] of candidates) {
    if (sessionCache.size <= maxEntries && totalBytes() <= maxBytes) break;
    writeDiskEntry(entry); // flush-before-evict: the replay survives in the disk tier
    sessionCache.delete(file);
  }
}

/** atime-based lazy sweep of the disk dir beyond the entry cap (boot-time). */
function sweepReplayCacheDir(): void {
  const p = policy();
  if (!p.diskEnabled || p.diskDir === "") return;
  if (p.maxEntries === 0) return; // unlimited → no cap to enforce
  let names: string[];
  try {
    names = readdirSync(p.diskDir);
  } catch {
    return; // dir missing → nothing to sweep (the next write recreates it)
  }
  const files = names
    // Both `<id>.json` and its crash orphan `<id>.json.tmp` are sweep-eligible;
    // the adoption path still reads exactly `<id>.json` (eligibility ≠ adoption).
    .filter((name) => name.endsWith(".json") || name.endsWith(".json.tmp"))
    .map((name) => join(p.diskDir, name))
    .map((path) => {
      try {
        return { path, atimeMs: statSync(path).atimeMs };
      } catch {
        return { path, atimeMs: 0 };
      }
    })
    .sort((a, b) => a.atimeMs - b.atimeMs);
  const excess = files.length - p.maxEntries;
  if (excess <= 0) return;
  for (const file of files.slice(0, excess)) {
    try {
      unlinkSync(file.path);
    } catch {
      // best-effort
    }
  }
}

/** Kick off one lazy boot sweep (deferred to first disk use, never at module load). */
function ensureDiskSweep(): void {
  if (swept) return;
  swept = true;
  sweepReplayCacheDir();
}

/** Mark one cache entry as just-viewed (LRU recency). */
export function touchSessionCacheEntry(file: string): void {
  const entry = sessionCache.get(file);
  if (entry !== undefined) entry.lastViewedAt = Date.now();
}

/** Test/diagnostic seam: override cache-policy bits in-process (pass null to reset). */
export function _setCachePolicyForTest(override: Partial<CachePolicy> | null): void {
  policyOverride = override;
  // NOTE: `swept` is intentionally NOT reset here — the boot sweep is once per
  // process (production-faithful); tests that need a sweep use the direct seam.
  if (diskFlushTimer !== null) {
    clearTimeout(diskFlushTimer);
    diskFlushTimer = null;
  }
  diskDirty.clear();
}

/** Test/diagnostic seam: drop the in-memory cache for a hermetic next test. */
export function _clearSessionCacheForTest(): void {
  sessionCache.clear();
  inflightFills.clear();
  if (diskFlushTimer !== null) {
    clearTimeout(diskFlushTimer);
    diskFlushTimer = null;
  }
  diskDirty.clear();
}

/** Test/diagnostic seam: flush pending debounced writes immediately. */
export function _flushDiskForTest(): void {
  flushDiskNow();
}

/** Test/diagnostic seam: run the disk-dir atime sweep synchronously. */
export function _sweepReplayCacheDirForTest(): void {
  sweepReplayCacheDir();
}

/** Test/diagnostic seam: number of disk-read attempts (adoption misses + hits). */
export function _getDiskReadCountForTest(): number {
  return diskReadCount;
}

/** Test/diagnostic seam: current in-memory cache size. */
export function _cacheSizeForTest(): number {
  return sessionCache.size;
}

/** The L1 transcript reader: SDK-first, JSONL fallback. Injectable for tests. */
type TranscriptReader = (file: string) => Promise<OmpTranscript>;

const defaultReader: TranscriptReader = async (file) => {
  // SDK is canonical when it has content; when it fails OR returns an empty
  // transcript the JSONL is the sole record of truth, so fall back — this keeps
  // one reader chain (SDK→JSONL) for BOTH the cold fill and the growth ingest
  // so they never derive divergent event counts that would skew cursor slicing.
  const sdk = await readOmpTranscriptSdk(file);
  if (sdk !== undefined && sdk.messages.length > 0) return sdk;
  return readOmpTranscript(file);
};

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
  // Disk tier (cold miss + boot warm): adopt a matching, valid disk replay.
  const adopted = adoptFromDisk(file, size, mtimeMs, preset, header, String(header.id));
  if (adopted !== undefined) return adopted;
  const run = fillSessionCacheEntry(file, preset, title, createdAt, header, logger, readTranscript, size, mtimeMs);
  inflightFills.set(file, run);
  try {
    return await run;
  } finally {
    if (inflightFills.get(file) === run) inflightFills.delete(file);
  }
}

/** Lenient (unvalidated) replay of one transcript, with the permission prefix. */
function replayLenient(
  preset: string | null,
  title: string | undefined,
  createdAt: number,
  messages: OmpMessage[],
  modelChanges: OmpModelChange[],
): SessionEvent[] {
  const replayed = replayOmpTranscript(messages, title, createdAt, modelChanges);
  return preset !== undefined && isPresetName(preset)
    ? [...permissionEventsFor(preset, createdAt), ...replayed].map((event, index) => ({ ...event, seq: SessionSeq(index) }))
    : replayed;
}

/** Validate (fail-soft to []), store, and return the frozen validated events. */
function storeValidated(
  file: string,
  preset: string | null,
  messages: OmpMessage[],
  lenient: SessionEvent[],
  size: number,
  mtimeMs: number,
  header: SessionHeader,
  logger: { warn: (message: string) => void },
): SessionEvent[] {
  let stored: SessionEvent[];
  try {
    stored = validateStoredEvents(header, lenient);
    assertContiguous(header.id, stored, 0);
  } catch (error) {
    // A malformed replay degrades that file's cold reads to an empty log until
    // its (size, mtime) changes — fail-soft, never the caller's boot/tick.
    logger.warn(`omp persistence: replay of "${file}" failed storage validation; serving empty log (${String(error)})`);
    stored = [];
  }
  storeEntryAndEvict(file, {
    size,
    mtimeMs,
    preset,
    messages,
    events: stored,
    cursor: { lastSeq: stored.length, size, mtimeMs },
    dshId: String(header.id),
    lastViewedAt: Date.now(),
  });
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
  traceParse(file);
  const lenient = replayLenient(preset, title, createdAt, messages, modelChanges);
  const stored = storeValidated(file, preset, messages, lenient, size, mtimeMs, header, logger);
  const entry = sessionCache.get(file);
  if (entry !== undefined) writeDiskEntry(entry); // after L2 fill: persist the replay
  return stored;
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

/** One growth pass: the lenient delta (detection) and the validated delta (projection). */
export interface SessionGrowth {
  /** Lenient (unvalidated) delta events past the cursor — for foreign-writer detection. */
  foreign: SessionEvent[];
  /** Validated + frozen delta — for the shadow projection (empty on validation failure). */
  shadow: SessionEvent[];
}

/**
 * The supervisor's incremental ingest (async, single reader lineage): stat the
 * file against the entry's cursor and, on growth, re-read + re-replay through
 * the SAME reader chain as the cold fill (`defaultReader`), then slice the
 * delta. Foreign detection runs on the LENIENT delta regardless of the entry
 * validation outcome; the validated delta feeds the shadow (empty on a
 * validation failure, whose entry re-fills fail-soft to an empty log — a later
 * growth then full-rescans, which is idempotent for detection).
 */
export async function ingestSessionFileGrowth(
  file: string,
  id: string,
  logger: { warn: (message: string) => void },
  readTranscript: TranscriptReader = defaultReader,
): Promise<SessionGrowth> {
  const cached = sessionCache.get(file);
  const cursor = cached?.cursor;
  if (cursor === undefined) return { foreign: [], shadow: [] };
  let size: number;
  let mtimeMs: number;
  try {
    const stats = statSync(file);
    size = stats.size;
    mtimeMs = stats.mtimeMs;
  } catch {
    return { foreign: [], shadow: [] };
  }
  if (size === cursor.size && mtimeMs === cursor.mtimeMs) return { foreign: [], shadow: [] };
  const row = getBridgeStore()?.byFile(file);
  const preset = row?.permission_preset ?? null;
  const title = row?.title ?? undefined;
  const createdAt = row?.created_at ?? 0;
  const header = row === undefined ? sessionHeaderForId(id) : sessionHeaderOf(row);
  const { messages, modelChanges } = await readTranscript(file);
  traceParse(file);
  const lenient = replayLenient(preset, title, createdAt, messages, modelChanges);
  const foreign = lenient.slice(cursor.lastSeq);
  const validated = storeValidated(file, preset, messages, lenient, size, mtimeMs, header, logger);
  const shadow = validated.slice(cursor.lastSeq);
  scheduleDiskWrite(file); // after incremental append: debounced (~2s) flush
  return { foreign, shadow };
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
   * NOT through `open`: boot warming never counts as a "view" for supervisor /
   * visited-at bookkeeping — the projection fill it triggers still stamps the
   * cache entry's LRU recency (`lastViewedAt`).
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
    const events = await this.eventsOf(row);
    if (access === "read") touchSessionCacheEntry(row.session_file); // LRU recency
    return new OmpSessionHandle(this.headerOf(row), access, events);
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
