/**
 * Supervisor cadence knobs — independent, env-tunable intervals that decouple
 * the global storage reconcile from the per-session cold file-follow from the
 * urgent transition-mode follow. `0` disables a cadence (TTL `0` = never evict).
 */
function parseMs(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

/** Whole-store scan cadence: workspace attach, list metadata, badge refresh. */
export const STORAGE_RECONCILE_INTERVAL_MS = parseMs(process.env.OMP_STORAGE_RECONCILE_INTERVAL_MS, 30_000);

/** Cold file-follow cadence for viewed shadow sessions (stat + incremental read). */
export const FILE_FOLLOW_INTERVAL_MS = parseMs(process.env.OMP_FILE_FOLLOW_INTERVAL_MS, 5_000);

/** Urgent cadence during avoidance (post-trigger watch while teardown lands). */
export const TRANSITION_FOLLOW_INTERVAL_MS = parseMs(process.env.OMP_TRANSITION_FOLLOW_INTERVAL_MS, 1_000);

/** Shadow eviction: dematerialize a viewed session after this long with no history request. `0` = never. */
export const SHADOW_TTL_MS = parseMs(process.env.OMP_SHADOW_TTL_MS, 15 * 60_000);

/** Count/byte knob: non-negative integer, `0` disables the cap (unlimited). */
function parseCount(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && Number.isInteger(value) && value >= 0 ? value : fallback;
}

/** Max in-memory {@link SessionCacheEntry} count; `0` = unlimited (house convention). */
export const OMP_CACHE_MAX_ENTRIES = parseCount(process.env.OMP_CACHE_MAX_ENTRIES, 512);

/** Max total transcript bytes retained in memory (sum of entry.size); `0` = unlimited. */
export const OMP_CACHE_MAX_BYTES = parseCount(process.env.OMP_CACHE_MAX_BYTES, 0);

/** Disk replay tier on/off: `"0"` disables the disk cache (house convention). */
export const OMP_CACHE_DISK = process.env.OMP_CACHE_DISK !== "0";

/** Explicit replay-cache dir override (absolute path); empty = derive `<DSH_HOME>/cache/replay`. */
export const OMP_CACHE_DIR = process.env.OMP_CACHE_DIR;

