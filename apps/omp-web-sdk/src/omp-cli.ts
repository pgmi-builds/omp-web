/**
 * OMP CLI subprocess helpers — the first-party CLI entries the bridge uses
 * instead of parsing OMP's files or hitting frame-limited RPC:
 *
 * - `omp models --json`     → the credential-resolved AVAILABLE model catalog
 *   (documented selectability rule: provider not in `disabledProviders` and
 *   keyless or with a resolvable credential — 7-level precedence, including
 *   OAuth/login keys stored in agent.db that no config file reveals).
 * - `omp config get modelRoles --json` → the role→"provider/model[:effort]"
 *   map, including the persisted `default` selector (TUI semantics: the
 *   default model IS config state, surviving sessions).
 * - `omp config set modelRoles --json <obj>` → whole-object roundtrip write
 *   (dotted keys are rejected; the entire modelRoles object is the unit).
 *
 * All calls run with cwd = `OMP_HOME` (omp writes its own state db next to
 * the agent dir) and inherit the daemon environment.
 *
 * @module omp-web/omp-cli
 */

import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const OMP_BIN = process.env.OMP_BIN ?? "omp";
const TIMEOUT_MS = 15_000;
const MAX_BUFFER = 64 * 1024 * 1024;

const ompHome = (): string | undefined => process.env.OMP_HOME;

const execFileSyncBound = (args: string[]): string | undefined => {
  const home = ompHome();
  if (home === undefined) return undefined;
  try {
    return execFileSync(OMP_BIN, args, { cwd: home, timeout: TIMEOUT_MS, encoding: "utf8", maxBuffer: MAX_BUFFER });
  } catch {
    return undefined;
  }
};

/**
 * Synchronous `omp models --json` — the boot-time variant (the adapter's
 * provider route list must be known before `registerAdapter` returns).
 * Blocks up to the timeout; prefer the async variant everywhere else.
 */
export function ompAvailableModelsSync(): OmpCliModel[] | undefined {
  const stdout = execFileSyncBound(["models", "--json"]);
  if (stdout === undefined) return undefined;
  try {
    const json = JSON.parse(stdout) as { models?: unknown } | undefined;
    if (json === null || typeof json !== "object" || !Array.isArray(json.models)) return undefined;
    const out: OmpCliModel[] = [];
    for (const model of json.models) {
      if (model !== null && typeof model === "object" && typeof (model as { provider?: unknown }).provider === "string") {
        out.push(model as OmpCliModel);
      }
    }
    return out.length > 0 ? out : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Synchronous `omp config get modelRoles --json` — boot-time variant of
 * the async `ompModelRoles`.
 */
export function ompModelRolesSync(): OmpModelRoles | undefined {
  const stdout = execFileSyncBound(["config", "get", "modelRoles", "--json"]);
  if (stdout === undefined) return undefined;
  try {
    const json = JSON.parse(stdout) as { key?: string; value?: unknown } | undefined;
    if (json === undefined || json === null || typeof json !== "object" || json.key !== "modelRoles") return undefined;
    const value = json.value;
    if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
    const out: OmpModelRoles = {};
    for (const [role, selector] of Object.entries(value)) {
      if (typeof selector === "string" && selector !== "") out[role] = selector;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  } catch {
    return undefined;
  }
}

/** One `omp <args>` invocation parsed as JSON; undefined on any failure. */
async function ompCliJson(args: string[]): Promise<unknown | undefined> {
  const home = ompHome();
  if (home === undefined) return undefined;
  try {
    const { stdout } = await execFileAsync(OMP_BIN, args, {
      cwd: home,
      timeout: TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
    });
    return JSON.parse(stdout);
  } catch {
    return undefined;
  }
}

/** One raw model record as OMP's catalog describes it. */
export interface OmpCliModel {
  provider: string;
  id: string;
  [key: string]: unknown;
}

/**
 * `omp models --json` — the AVAILABLE model catalog (credential-resolved,
 * `disabledProviders`-aware). `undefined` when OMP_HOME is unset or the CLI
 * fails; callers fall back to the on-disk sources.
 */
export async function ompAvailableModels(): Promise<OmpCliModel[] | undefined> {
  const json = await ompCliJson(["models", "--json"]);
  if (json === null || typeof json !== "object") return undefined;
  const models = (json as { models?: unknown }).models;
  if (!Array.isArray(models)) return undefined;
  const out: OmpCliModel[] = [];
  for (const model of models) {
    if (model !== null && typeof model === "object" && typeof (model as { provider?: unknown }).provider === "string") {
      out.push(model as OmpCliModel);
    }
  }
  return out.length > 0 ? out : undefined;
}

/** role → "provider/model[:effort]" selectors, from the live config. */
export interface OmpModelRoles {
  [role: string]: string;
}

/**
 * `omp config get modelRoles --json` — the current modelRoles object.
 * `undefined` when unset or the CLI fails.
 */
export async function ompModelRoles(): Promise<OmpModelRoles | undefined> {
  const json = await ompCliJson(["config", "get", "modelRoles", "--json"]);
  if (json === null || typeof json !== "object") return undefined;
  const value = (json as { value?: unknown }).value;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const out: OmpModelRoles = {};
  for (const [role, selector] of Object.entries(value)) {
    if (typeof selector === "string" && selector !== "") out[role] = selector;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * `omp config set modelRoles --json <obj>` — the TUI-grade default-model
 * write: OMP persists `modelRoles.default` itself, so every new session
 * (TUI or Web) inherits the selection. Whole-object roundtrip: dotted keys
 * are rejected by the CLI.
 */
export async function ompSetModelRoles(roles: OmpModelRoles): Promise<boolean> {
  const home = ompHome();
  if (home === undefined) return false;
  try {
    await execFileAsync(OMP_BIN, ["config", "set", "modelRoles", "--json", JSON.stringify(roles)], {
      cwd: home,
      timeout: TIMEOUT_MS,
    });
    return true;
  } catch {
    return false;
  }
}
