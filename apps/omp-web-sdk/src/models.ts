/**
 * OMP model catalog for the Dash model selector.
 *
 * The browser model selector is a pure RPC round-trip through the apiproxy:
 * `session.models` reads `ctx.llm.listProviders/listModels/resolveModelInfo`,
 * so the OMP provider registers an `LlmAdapter` whose catalog is OMP's real
 * AVAILABLE model set. This module owns the source of that catalog.
 *
 * Source: `omp models --json` (first-party CLI, `omp-cli.ts`) — OMP's own
 * credential-resolved availability verdict. The documented selectability
 * rule (provider not in `disabledProviders` and keyless or with a
 * resolvable credential) runs through a 7-level credential precedence that
 * includes OAuth/login keys stored in agent.db — a state NO config file
 * reveals, which is why the catalog must come from OMP itself.
 *
 * The authoritative RPC `get_available_models` would serve the same set but
 * exceeds the 1 MiB transport frame limit for this install; the CLI returns
 * the compact form (~50 models / 5 providers, 15 KB, ~1.7s). The on-disk
 * `models.db` ∪ `models.yml` pair remains ONLY as the subprocess-failure
 * fallback (registry-cache noise included) — never the primary.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ompAvailableModels, ompAvailableModelsSync, ompModelRolesSync } from "./omp-cli.js";
import { ReasoningEffortId, type LlmModelInfo, type LlmResolvedModelInfo, type ModelModality } from "@deepseek-ai/dsh-llm";

/** One model as OMP's registry describes it (`get_available_models` / model_cache / models.yml). */
export interface OmpModel {
  id: string;
  name: string;
  provider: string;
  api?: string;
  baseUrl?: string;
  reasoning?: boolean;
  input?: string[];
  contextWindow?: number | null;
  maxTokens?: number | null;
  thinking?: { mode?: string; efforts?: string[]; defaultLevel?: string };
}

const OMP_AGENT_DIR = join(process.env.OMP_HOME ?? join(homedir(), ".omp"), "agent");

/**
 * Providers named by config.yml `modelRoles` lead the selector: they are the
 * roles the operator actually wired (the TUI default-model semantics).
 */
let cached: OmpModel[] | null = null;

/**
 * Read the AVAILABLE OMP model catalog, memoized. First call prefers the CLI
 * (`omp models --json`, synchronous — the boot route list must be known
 * before `registerAdapter` returns); a CLI failure falls back to the on-disk
 * registry cache with a stderr note. Later refreshes go through
 * `refreshOmpModelsCli` (async, per reconcile tick).
 */
export function loadOmpModels(): OmpModel[] {
  if (cached === null) {
    const cli = ompAvailableModelsSync();
    if (cli !== undefined) {
      cached = cli.map((model) => normalizeModel(model)).filter((model): model is OmpModel => model !== null);
    } else {
      process.stderr.write("[omp-provider] omp models --json unavailable; falling back to the on-disk model cache\n");
      cached = mergeModels(loadModelsDb(), loadModelsYml());
    }
  }
  return cached;
}

/**
 * Re-run the CLI catalog and swap the memo on success.
 * @returns whether the refresh produced a fresh catalog.
 */
export async function refreshOmpModelsCli(): Promise<boolean> {
  const cli = await ompAvailableModels();
  if (cli === undefined) return false;
  cached = cli.map((model) => normalizeModel(model)).filter((model): model is OmpModel => model !== null);
  return true;
}


/** The distinct provider ids across the catalog, modelRoles roles first. */
export function ompProviderIds(models: OmpModel[] = loadOmpModels()): string[] {
  const seen = new Set<string>();
  for (const model of models) seen.add(model.provider);
  const ordered: string[] = [];
  // Providers the operator wired into modelRoles lead the selector (TUI
  // semantics: the roles actually in use); everything else follows
  // alphabetically.
  for (const selector of Object.values(ompModelRolesSync() ?? {})) {
    const slash = selector.indexOf("/");
    const provider = slash > 0 ? selector.slice(0, slash) : "";
    if (provider !== "" && seen.has(provider) && !ordered.includes(provider)) ordered.push(provider);
  }
  for (const provider of [...seen].sort((a, b) => a.localeCompare(b))) {
    if (!ordered.includes(provider)) ordered.push(provider);
  }
  return ordered;
}



/** Human-readable provider name for `LlmProviderInfo.name`. */
export function providerDisplayName(provider: string): string {
  const titles: Record<string, string> = { zai: "Z.AI", xai: "xAI", openrouter: "OpenRouter" };
  return titles[provider] ?? (provider.charAt(0).toUpperCase() + provider.slice(1));
}

/** Merge the registry cache under the user overlay (later models win per provider+id). */
function mergeModels(cache: OmpModel[], overlay: OmpModel[]): OmpModel[] {
  if (overlay.length === 0) return cache;
  const byKey = new Map<string, OmpModel>();
  for (const model of cache) byKey.set(model.provider + "/" + model.id, model);
  for (const model of overlay) byKey.set(model.provider + "/" + model.id, model);
  return [...byKey.values()];
}

/**
 * Read `~/.omp/agent/models.db` (`model_cache.models` JSON column). This is
 * the on-disk form of the registry `get_available_models` serves. Read-only
 * and tolerant of a missing/empty file (OMP may not have refreshed it yet).
 */
function loadModelsDb(): OmpModel[] {
  const out: OmpModel[] = [];
  try {
    const db = new DatabaseSync(join(OMP_AGENT_DIR, "models.db"), { readOnly: true });
    try {
      const rows = db.prepare("SELECT models FROM model_cache").all() as { models: string }[];
      for (const row of rows) {
        try {
          const models = JSON.parse(row.models) as unknown;
          if (!Array.isArray(models)) continue;
          for (const model of models) {
            const parsed = normalizeModel(model);
            if (parsed !== null) out.push(parsed);
          }
        } catch {
          // one malformed provider row must not sink the whole catalog
        }
      }
    } finally {
      db.close();
    }
  } catch {
    // absent db / schema drift → fall through to the overlay alone
  }
  return out;
}

/**
 * Parse `~/.omp/agent/models.yml` — a `providers: <id>: { models: [ ... ] }`
 * overlay OMP writes. A focused indentation scan is enough for this fixed
 * shape and avoids pulling `js-yaml` into the provider's dependency surface.
 * Any parse failure degrades to an empty overlay.
 */
function loadModelsYml(): OmpModel[] {
  const out: OmpModel[] = [];
  let text: string;
  try {
    text = readFileSync(join(OMP_AGENT_DIR, "models.yml"), "utf8");
  } catch {
    return out;
  }
  let provider = "";
  let inModels = false;
  let model: Record<string, unknown> | null = null;
  const push = () => {
    if (model !== null) {
      const parsed = normalizeModel({ ...model, provider });
      if (parsed !== null) out.push(parsed);
      model = null;
    }
  };
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    const trimmed = line.trim();
    if (indent === 0) {
      if (trimmed === "providers:") { provider = ""; inModels = false; model = null; }
      else { provider = ""; inModels = false; model = null; }
      continue;
    }
    if (indent === 2 && trimmed.endsWith(":")) {
      push();
      provider = trimmed.slice(0, -1).trim();
      inModels = false;
      continue;
    }
    if (indent === 4 && trimmed === "models:") {
      inModels = true;
      continue;
    }
    if (inModels && indent >= 6 && trimmed.startsWith("- ")) {
      push();
      model = {};
      const entry = trimmed.slice(2).trim();
      const colon = entry.indexOf(":");
      if (colon > 0) model[entry.slice(0, colon).trim()] = entry.slice(colon + 1).trim();
      continue;
    }
    if (inModels && model !== null && indent >= 8) {
      const colon = trimmed.indexOf(":");
      if (colon > 0) {
        const key = trimmed.slice(0, colon).trim();
        model[key] = trimmed.slice(colon + 1).trim();
      }
      continue;
    }
    // Any other shape is outside the models list we care about.
  }
  push();
  return out;
}

/** Coerce one raw model record into an {@link OmpModel}, or null when unusable. */
function normalizeModel(raw: unknown): OmpModel | null {
  if (raw === null || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const id = typeof record.id === "string" ? record.id : "";
  const provider = typeof record.provider === "string" ? record.provider : "";
  const name = typeof record.name === "string" && record.name !== "" ? record.name : id;
  if (id === "" || provider === "" || name === "") return null;
  const thinking = normalizeThinking(record.thinking);
  return {
    id,
    provider,
    name,
    ...(typeof record.api === "string" ? { api: record.api } : {}),
    ...(typeof record.baseUrl === "string" ? { baseUrl: record.baseUrl } : {}),
    ...(typeof record.reasoning === "boolean" ? { reasoning: record.reasoning } : {}),
    ...(Array.isArray(record.input) ? { input: record.input.filter((m): m is string => typeof m === "string") } : {}),
    ...(typeof record.contextWindow === "number" ? { contextWindow: record.contextWindow } : {}),
    ...(typeof record.maxTokens === "number" ? { maxTokens: record.maxTokens } : {}),
    ...(thinking === undefined ? {} : { thinking }),
  };
}

/** Map OMP's declared input modalities to the harness vocabulary. */
function inputModalities(model: OmpModel): ModelModality[] | undefined {
  if (model.input === undefined) return undefined;
  const modalities = model.input.filter((m): m is ModelModality => m === "text" || m === "image");
  return modalities.length === 0 ? undefined : modalities;
}

/** Extract OMP's `thinking` sub-object, checking each field at the boundary. */
function normalizeThinking(raw: unknown): OmpModel["thinking"] {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const t = raw as Record<string, unknown>;
  return {
    ...(typeof t.mode === "string" ? { mode: t.mode } : {}),
    ...(Array.isArray(t.efforts) ? { efforts: t.efforts.filter((e): e is string => typeof e === "string") } : {}),
    ...(typeof t.defaultLevel === "string" ? { defaultLevel: t.defaultLevel } : {}),
  };
}

/** Map OMP `thinking.efforts` into the adapter reasoning-effort vocabulary. */
function reasoningInfo(model: OmpModel): LlmResolvedModelInfo["reasoning"] {
  const efforts = model.thinking?.efforts ?? [];
  if (efforts.length === 0) return undefined;
  const ids = new Set<string>();
  const mapped = efforts
    .filter((effort) => effort !== "" && !ids.has(effort) && (ids.add(effort), true))
    .map((effort) => ({ id: ReasoningEffortId(effort), name: effort }));
  if (mapped.length === 0) return undefined;
  const defaultEffort = model.thinking?.defaultLevel;
  return {
    efforts: mapped,
    ...(defaultEffort !== undefined && ids.has(defaultEffort) ? { defaultEffort: ReasoningEffortId(defaultEffort) } : {}),
  };
}

/** One catalog row: {@link LlmModelInfo} for `listModels`. */
export function toModelInfo(model: OmpModel): LlmModelInfo {
  return {
    provider: model.provider,
    id: model.id,
    name: model.name,
    ...(inputModalities(model) === undefined ? {} : { inputModalities: inputModalities(model) }),
  };
}

/** One exact-model resolution: {@link LlmResolvedModelInfo} for `resolveModel`. */
export function toResolvedModelInfo(model: OmpModel): LlmResolvedModelInfo {
  const info = toModelInfo(model);
  const contextWindow = typeof model.contextWindow === "number" && model.contextWindow > 0 ? model.contextWindow : undefined;
  const defaultMaxTokens = typeof model.maxTokens === "number" && model.maxTokens > 0 ? model.maxTokens : undefined;
  const reasoning = reasoningInfo(model);
  return {
    ...info,
    ...(contextWindow === undefined ? {} : { context: { contextWindow } }),
    ...(defaultMaxTokens === undefined ? {} : { defaultMaxTokens }),
    ...(reasoning === undefined ? {} : { reasoning }),
  };
}
