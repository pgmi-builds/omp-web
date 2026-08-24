/**
 * Dash permission preset ↔ OMP approval mode, plus the bridge's own
 * per-session persistence for the preset.
 *
 * OMP has no runtime approval control: `--approval-mode` is a launch flag,
 * no RPC changes it mid-session. Dash's 3-way permission preset is therefore
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
 * The preset is a Dash-side session fact OMP never records, so the bridge
 * owns a tiny artifact next to OMP's transcript
 * (`<OMP_SESSIONS_ROOT>/<dashed-cwd>/<session>/webui.json`) to survive
 * wrapper restarts: cold reads synthesize the three Dash permission events
 * from it, and resume re-derives the spawn flag. Best-effort everywhere —
 * a missing or unreadable artifact degrades to the native default, never
 * breaks the session flow.
 */
import { mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Context } from "@deepseek-ai/cordis";
import type { SessionEvent } from "@deepseek-ai/dsh-session";
import { OMP_SESSIONS_ROOT } from "./omp-store.js";

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

/** Diagnostic trace (OMP_TRACE=1 on the dsh process enables stderr tracing). */
const trace = (...parts: unknown[]): void => {
  if (process.env.OMP_TRACE === "1") process.stderr.write(`[omp-permission ${Date.now() % 1_000_000}] ${parts.join(" ")}\n`);
};

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
 * The bridge-owned artifact path for one OMP session: the per-session
 * directory OMP itself conventions next to its `<id>.jsonl` transcript
 * (`<dashed-cwd>/<file-stem>/`, where OMP drops its `.bash.log` tool
 * artifacts). `webui.json` cannot collide with anything OMP writes.
 */
export function webuiArtifactPath(sessionFile: string): string {
  const base = sessionFile.split("/").pop() ?? sessionFile;
  const stem = base.endsWith(".jsonl") ? base.slice(0, -".jsonl".length) : base;
  return join(dirname(sessionFile), stem, "webui.json");
}

/** Guard: the artifact must stay inside OMP's native store. */
function insideStore(artifact: string): boolean {
  try {
    return artifact.startsWith(`${realpathSync(OMP_SESSIONS_ROOT)}/`);
  } catch {
    return false;
  }
}


/** stat token for the memoized cold-read cache. */
export interface WebuiStat {
  size: number;
  mtimeMs: number;
}

/** Stat the artifact without reading it; undefined when absent/unreadable. */
export function statWebuiArtifact(sessionFile: string): WebuiStat | undefined {
  const artifact = webuiArtifactPath(sessionFile);
  try {
    const stats = statSync(artifact);
    return { size: stats.size, mtimeMs: stats.mtimeMs };
  } catch {
    return undefined;
  }
}

/** Read the persisted preset; undefined when absent, unreadable, or unknown. */
export function readWebuiPreset(sessionFile: string): string | undefined {
  let raw: string;
  try {
    raw = readFileSync(webuiArtifactPath(sessionFile), "utf8");
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== "object") return undefined;
    const preset = (parsed as Record<string, unknown>)["permissionPreset"];
    return typeof preset === "string" && isPresetName(preset) ? preset : undefined;
  } catch {
    return undefined;
  }
}

/** The per-session fields the bridge persists beside OMP's transcript. */
export interface WebuiArtifactFields {
  /** The Dash session id that owns this OMP session (audit metadata). */
  readonly dashSessionId?: string;
  /** The permission preset stamped at createAgent time. */
  readonly preset?: string;
}


/**
 * Persist the webui artifact atomically (tmp file + rename), best-effort:
 * failures are traced and swallowed — a lost artifact only degrades
 * cold-replay fidelity, never the live session. `dashSessionId` is audit
 * metadata (the only durable Dash↔OMP pairing record); no code reads it.
 */
export function writeWebuiArtifact(sessionFile: string, fields: WebuiArtifactFields): void {
  const artifact = webuiArtifactPath(sessionFile);
  if (!insideStore(artifact)) {
    trace(`write: artifact path escaped the OMP store (${artifact}); skipped`);
    return;
  }
  const value = {
    ...(fields.dashSessionId === undefined ? {} : { dashSessionId: fields.dashSessionId }),
    ...(fields.preset !== undefined && isPresetName(fields.preset) ? { permissionPreset: fields.preset } : {}),
  };
  try {
    mkdirSync(dirname(artifact), { recursive: true });
    const tmp = `${artifact}.tmp-${randomUUID()}`;
    writeFileSync(tmp, `${JSON.stringify(value, undefined, 2)}\n`);
    renameSync(tmp, artifact);
    trace(`write: ${artifact} dashSessionId=${fields.dashSessionId ?? "-"} preset=${fields.preset ?? "-"}`);
  } catch (error) {
    trace(`write: ${artifact} FAILED ${String(error)}`);
  }
}
