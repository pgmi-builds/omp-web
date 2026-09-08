/**
 * Dash↔OMP session id pairing, backed by the centralized index (DB).
 *
 * The index is the sole pairing authority (D3): bridge-created sessions carry
 * their real Dash id (migrated from webui.json or written at createAgent);
 * every other OMP session gets a deterministic derived id (`session-` + the
 * OMP uuidv7, whose version nibble 7 ≠ 4 keeps it collision-free against
 * apiproxy-minted ids). All id translation is now an O(1) indexed lookup —
 * no webui.json read/write, no full-store scan.
 */
import { getBridgeStore } from "./store/index.js";
import type { SessionRow } from "./store/db.js";
import { scanOmpSessions, type OmpNativeSession } from "./omp-store.js";

/** The Dash-format prefix apiproxy mints; derived ids reuse it verbatim. */
const DASH_PREFIX = "session-";

/** Reconstruct a scanned-entry-shaped view from an index row. */
function rowToEntry(row: SessionRow): OmpNativeSession {
  return {
    ompSessionId: row.omp_session_id,
    ompSessionFile: row.session_file,
    ...(row.cwd === null ? {} : { cwd: row.cwd }),
    createdAt: row.created_at,
    ...(row.title === null ? {} : { title: row.title }),
    size: row.transcript_size,
    mtimeMs: row.last_modified_at,
    revision: `omp:${row.transcript_size}:${row.last_modified_at}`,
  };
}

/**
 * Resolve an id from the Dash side back to its session entry. Indexed lookup
 * (byDshId / byOmpId) — never a full scan. Falls back to the scanner only
 * when the store is absent (unit tests running the supervisor in isolation).
 */
export function resolveEntryById(id: string): OmpNativeSession | undefined {
  const store = getBridgeStore();
  if (store !== undefined) {
    const row = id.startsWith(DASH_PREFIX) ? store.byDshId(id) : store.byOmpId(id);
    return row === undefined ? undefined : rowToEntry(row);
  }
  if (id.startsWith(DASH_PREFIX)) {
    const stripped = id.slice(DASH_PREFIX.length);
    const direct = scanOmpSessions().get(stripped);
    return direct;
  }
  return scanOmpSessions().get(id);
}
