/**
 * Dash permission preset ↔ OMP approval mode.
 *
 * OMP has no runtime approval control: `--approval-mode` is a launch flag, no
 * RPC changes it mid-session. Dash's 3-way permission preset is therefore
 * resolved once, when the OMP child is spawned, and mapped explicitly:
 *
 *   danger-full-access → `--approval-mode yolo`   (OMP's own native default)
 *   workspace-write    → `--approval-mode write`
 *   read-only          → `--approval-mode always-ask`
 *   no explicit preset → yolo (native default)
 *
 * `OMP_APPROVAL_MODE` (a valid mode) overrides the mapping — headless test
 * runs pin the flag without composing a preset default.
 *
 * The preset is a Dash-side session fact OMP never records. It now lives in
 * the centralized index (`sessions.permission_preset`), seeded once from the
 * legacy per-session webui.json by the migration; webui.json stays on disk
 * but is never read or written again (D3).
 */
import { dirname, join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import type { SessionEvent } from "@deepseek-ai/dsh-session";

/** The approval modes OMP actually implements (unknown modes degrade to yolo). */
const APPROVAL_MODES = ["write", "always-ask", "yolo"] as const;

/** The Dash preset table (mirrors the base bundle's permission plugin config). */
const PRESETS = {
  "danger-full-access": { sandbox: "danger-full-access", approval: "never", ompMode: "yolo" },
  "workspace-write": { sandbox: "workspace-write", approval: "ask", ompMode: "write" },
  "read-only": { sandbox: "read-only", approval: "ask", ompMode: "always-ask" },
} as const;

/**
 * The two permission event keys this module reads/synthesizes that the
 * locally-resolved dsh-session build does not know (upstream declares them
 * in dsh-permission-presets / dsh-sandbox-policy, whose types this project
 * does not reference). Mirrored verbatim so `SessionEvent` narrows.
 */
declare module "@deepseek-ai/dsh-session/types" {
  interface SessionEventMap {
    "permission/preset": { preset: string };
    "sandbox/mode": { mode: "read-only" | "workspace-write" | "danger-full-access"; source?: "delegation" };
  }
}

type PresetName = keyof typeof PRESETS;

/** Narrow an untrusted value to a known preset name. */
export function isPresetName(raw: unknown): raw is PresetName {
  return typeof raw === "string" && Object.hasOwn(PRESETS, raw);
}

/**
 * `OMP_APPROVAL_MODE` when it names a mode OMP implements, else undefined.
 * An invalid value is IGNORED (the preset mapping applies) — the old
 * fall-back-to-`write` behavior silently downgraded from OMP's native yolo.
 */
export function envApprovalMode(): string | undefined {
  const raw = process.env.OMP_APPROVAL_MODE;
  return raw !== undefined && (APPROVAL_MODES as readonly string[]).includes(raw) ? raw : undefined;
}

/** Map a preset onto OMP's `--approval-mode` flag value; no preset → yolo. */
export function ompApprovalMode(preset: string | undefined): string {
  return isPresetName(preset) ? PRESETS[preset].ompMode : "yolo";
}

/** The slice of `ctx.permissionPresets` the bridge reads. */
interface PermissionPresetsSlice {
  defaultPreset: string;
}

/**
 * The default preset for FUTURE sessions, as the permission service
 * resolves it (settings-backed; the profile patch pins the base default).
 * Undefined when the service is absent or its getter fails — callers fall
 * back to OMP's native default.
 */
export function defaultPermissionPreset(ctx: Context): string | undefined {
  const service = ctx.get("permissionPresets") as PermissionPresetsSlice | undefined;
  if (service === undefined) return undefined;
  try {
    const preset = service.defaultPreset;
    return isPresetName(preset) ? preset : undefined;
  } catch {
    return undefined;
  }
}

/** The session's effective preset: the last `permission/preset` event. */
export function presetFromEvents(events: readonly SessionEvent[]): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.type === "permission/preset" && isPresetName(event.data?.preset)) return event.data.preset;
  }
  return undefined;
}

/**
 * The three Dash events `pinInitialPermission` stamps for a fresh session,
 * in its append order (preset, sandbox, approval). Cold replay prepends
 * them so the UI shows the session's permission after wrapper restarts.
 */
export function permissionEventsFor(preset: PresetName, time: number): SessionEvent[] {
  const spec = PRESETS[preset];
  return [
    { type: "permission/preset", time, data: { preset } },
    { type: "sandbox/mode", time, data: { mode: spec.sandbox } },
    { type: "approval/policy", time, data: { policy: spec.approval } },
  ] as unknown as SessionEvent[];
}

/**
 * The bridge's legacy per-session artifact path (the migration reads this to
 * import the old `dashSessionId` / `permissionPreset` once). Kept read-only;
 * nothing writes it after the migration.
 */
export function webuiArtifactPath(sessionFile: string): string {
  const base = sessionFile.split("/").pop() ?? sessionFile;
  const stem = base.endsWith(".jsonl") ? base.slice(0, -".jsonl".length) : base;
  return join(dirname(sessionFile), stem, "webui.json");
}
