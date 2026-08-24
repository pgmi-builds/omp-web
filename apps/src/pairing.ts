/**
 * Dash↔OMP session id pairing (dev_0.0.3 §11).
 *
 * The bridge speaks two id dialects: Dash mints `session-<uuid4>` (apiproxy)
 * and never accepts a foreign id, while OMP mints its own uuidv7 that no
 * upstream method may ever see. The pairing rule:
 *
 *   - Bridge-created sessions carry the REAL Dash id in their per-session
 *     `webui.json` (`dashSessionId`, written once at createAgent).
 *   - Every other OMP session (TUI-born, or predating the pairing field)
 *     gets a deterministic derived id: `session-` + the OMP uuidv7. The uuid
 *     version nibble (7 ≠ 4) makes collisions with apiproxy-minted ids
 *     impossible. The derived id is ALSO persisted to webui.json on first
 *     sight, so the pairing is durable data (auditable, uniform with
 *     bridge-created sessions), not a runtime formula.
 *
 * All id translation happens at the persistence/factory boundary; inside the
 * bridge everything stays keyed by the scanned OMP entry.
 */
import { readWebuiDashId, writeWebuiDashId } from "./permission.js";
import { scanOmpSessions, type OmpNativeSession } from "./omp-store.js";

/** The Dash-format prefix apiproxy mints; derived ids reuse it verbatim. */
const DASH_PREFIX = "session-";

/** The Dash-facing id for one scanned OMP session (real pairing or derived). */
export function dashIdOf(entry: OmpNativeSession): string {
  const existing = readWebuiDashId(entry.ompSessionFile);
  if (existing !== undefined) return existing;
  const derived = `${DASH_PREFIX}${entry.ompSessionId}`;
  writeWebuiDashId(entry.ompSessionFile, derived);
  return derived;
}

/**
 * Resolve an id from the Dash side back to its scanned OMP entry. Derived
 * ids strip to a direct scan hit; real Dash ids reverse-look-up the
 * webui.json pairing; a raw OMP id is accepted as a last resort so any
 * internal OMP-id caller keeps working. Undefined = genuinely unknown.
 */
export function resolveEntryById(id: string): OmpNativeSession | undefined {
  if (id.startsWith(DASH_PREFIX)) {
    const stripped = id.slice(DASH_PREFIX.length);
    const direct = scanOmpSessions().get(stripped);
    if (direct !== undefined) return direct;
    for (const entry of scanOmpSessions().values()) {
      if (readWebuiDashId(entry.ompSessionFile) === id) return entry;
    }
    return undefined;
  }
  return scanOmpSessions().get(id);
}
