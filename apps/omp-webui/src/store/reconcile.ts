/**
 * Reconcile between the centralized index and OMP's native store.
 *
 * Three cadences (D5):
 *   1. warm pass — full scan + upsert before the bridge serves traffic;
 *   2. periodic reconcile — stat walk + diff, full-read only new/changed
 *      files, prune vanished files;
 *   3. event-driven increments — createAgent INSERT, live model-switch
 *      UPDATE, teardown stat UPDATE (fire immediately, no cycle wait).
 *
 * Plus the one-time webui.json → DB migration (D3): read legacy
 * `dashSessionId` / `permissionPreset`, overwrite a still-derived
 * `dsh_session_id` / null `permission_preset` in the index. Idempotent.
 */
import { readFileSync, statSync } from "node:fs";
import type { BridgeStore, SessionRow } from "./db.js";
import { lastModelCall, lastRestorableModel, readOmpTranscript, scanOmpSessions, type OmpNativeSession } from "../omp-store.js";
import { isPresetName, webuiArtifactPath } from "../permission.js";

/** The Dash-format prefix apiproxy mints; derived ids reuse it verbatim. */
const DASH_PREFIX = "session-";

/** The deterministic derived id for a TUI-born OMP session. */
export function derivedDashId(ompSessionId: string): string {
  return `${DASH_PREFIX}${ompSessionId}`;
}

/**
 * Full metadata extraction for one scanned entry: reads the whole transcript
 * to recover the tail model (D6), preserving the existing row's UI fields,
 * pairing, and preset.
 */
function rowFromEntry(entry: OmpNativeSession, existing?: SessionRow): SessionRow {
  const { messages, modelChanges } = readOmpTranscript(entry.ompSessionFile);
  const model = lastRestorableModel(modelChanges) ?? lastModelCall(messages);
  return {
    omp_session_id: entry.ompSessionId,
    dsh_session_id: existing?.dsh_session_id ?? derivedDashId(entry.ompSessionId),
    session_file: entry.ompSessionFile,
    cwd: entry.cwd ?? null,
    title: entry.title ?? null,
    created_at: entry.createdAt,
    last_modified_at: entry.mtimeMs,
    transcript_size: entry.size,
    model_provider: model?.provider ?? null,
    model_id: model?.model ?? null,
    agent_preset: existing?.agent_preset ?? "omp",
    permission_preset: existing?.permission_preset ?? null,
    forked_from: existing?.forked_from ?? null,
    archived: existing?.archived ?? 0,
    last_visited_at: existing?.last_visited_at ?? null,
  };
}

/**
 * One full reconcile pass: scan, diff against the index, full-read + upsert
 * new/changed sessions, prune vanished files. Used both as the boot warm pass
 * and the periodic reconcile. Held/live sessions are skipped by construction
 * (their files are only read when stat-different).
 */
export function reconcileOnce(store: BridgeStore): void {
  store.ensureUngroupedWorkspace();
  const keep = new Set<string>();
  for (const entry of scanOmpSessions().values()) {
    keep.add(entry.ompSessionFile);
    const existing = store.byFile(entry.ompSessionFile);
    if (existing !== undefined && existing.transcript_size === entry.size && existing.last_modified_at === entry.mtimeMs) {
      continue; // unchanged — no full read
    }
    store.upsert(rowFromEntry(entry, existing));
  }
  store.prune(keep);
}

/** Event-driven INSERT at createAgent: record identity + preset; reconcile fills metadata. */
export function upsertCreated(
  store: BridgeStore,
  input: { ompSessionId: string; sessionFile: string; dshSessionId: string; cwd?: string; preset?: string },
): void {
  let size = 0;
  let mtimeMs = Date.now();
  try {
    const stat = statSync(input.sessionFile);
    size = stat.size;
    mtimeMs = stat.mtimeMs;
  } catch {
    // File not yet flushable — the reconcile will fill stat on the next pass.
  }
  store.upsert({
    omp_session_id: input.ompSessionId,
    dsh_session_id: input.dshSessionId,
    session_file: input.sessionFile,
    cwd: input.cwd ?? null,
    title: null,
    created_at: Date.now(),
    last_modified_at: mtimeMs,
    transcript_size: size,
    model_provider: null,
    model_id: null,
    agent_preset: "omp",
    permission_preset: input.preset ?? null,
    forked_from: null,
    archived: 0,
    last_visited_at: null,
  });
}

/**
 * One-time webui.json → DB migration (D3). Overwrites a session's pairing only
 * when its index row still carries the derived id, and its preset only when
 * the column is still null — so a re-run never clobbers a real Dash id.
 */
export function migrateWebuiJson(store: BridgeStore): void {
  for (const entry of scanOmpSessions().values()) {
    const row = store.byFile(entry.ompSessionFile);
    if (row === undefined) continue;
    let raw: string;
    try {
      raw = readFileSync(webuiArtifactPath(entry.ompSessionFile), "utf8");
    } catch {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      continue;
    }
    if (parsed === null || typeof parsed !== "object") continue;
    const fields = parsed as Record<string, unknown>;
    const dashId = fields["dashSessionId"];
    if (typeof dashId === "string" && dashId.length > 0 && row.dsh_session_id === derivedDashId(entry.ompSessionId)) {
      store.setDshId(row.omp_session_id, dashId);
      row.dsh_session_id = dashId;
    }
    const preset = fields["permissionPreset"];
    if (typeof preset === "string" && isPresetName(preset) && row.permission_preset === null) {
      store.setPermissionPreset(row.omp_session_id, preset);
    }
  }
}
