/**
 * SingleOmpPresetRoster — the profile's `agentPresets` service.
 *
 * OMP is single-mode: the OMP agent drives its own tools through its RPC
 * process, so no Dash-side preset composition exists to choose from. But the
 * web surfaces (new-session mode dropdown, Settings → Agent Preset) render
 * from the roster RPC, and an absent roster renders "empty" rather than "one
 * mode". This service publishes exactly one non-authorable preset, `OMP`,
 * whose composition is deliberately empty — mounting it composes nothing,
 * exactly the rosterless behavior the provider runs on.
 */
import { Service, type Context } from "@deepseek-ai/cordis";
import { UnknownPresetError, type AgentPreset } from "@deepseek-ai/dsh-agent-presets";
import type { ScopeKey } from "@deepseek-ai/dsh-scope";

const OMP_PRESET: AgentPreset = Object.freeze({
  id: "omp",
  trust: "system",
  path: "",
  name: "OMP",
  description: "A single OMP agent session; the composition is owned by the OMP provider.",
});

const COMPOSITION_TEXT = [
  "# OMP (fixed roster)",
  "",
  "This deployment runs exactly one agent mode: the OMP provider bridges Dash",
  "sessions to a native OMP agent over RPC. There is no per-session plugin",
  "composition to configure, so this preset mounts nothing.",
  "",
  "rows: []",
  "",
].join("\n");

/** The standing scope key every `omp` session reads presenters through. */
const STANDING_KEY: ScopeKey = {};

export class SingleOmpPresetRoster extends Service {
  constructor(ctx: Context) {
    super(ctx, "agentPresets");
  }

  get defaultId(): string {
    return OMP_PRESET.id;
  }

  get roots(): readonly never[] {
    return [];
  }

  get authorable(): boolean {
    return false;
  }

  async list(): Promise<AgentPreset[]> {
    return [OMP_PRESET];
  }

  async resolve(id?: string): Promise<AgentPreset> {
    if (id === undefined || id === OMP_PRESET.id) return OMP_PRESET;
    throw new UnknownPresetError(id, [OMP_PRESET.id]);
  }

  async mount(_agentCtx: Context, id?: string): Promise<AgentPreset> {
    return this.resolve(id);
  }

  async recompose(_agentCtx: Context, id: string): Promise<AgentPreset> {
    return this.resolve(id);
  }

  async read(id: string): Promise<string> {
    await this.resolve(id);
    return COMPOSITION_TEXT;
  }

  async copy(_from: string, _id: string, _name?: string): Promise<void> {
    throw new Error("the OMP roster is fixed: it ships exactly one preset and cannot be authored");
  }

  async remove(_id: string): Promise<void> {
    throw new Error("the OMP roster is fixed: it ships exactly one preset and cannot be authored");
  }

  serviceFor(_agent: { ctx: Context }, _name: string): undefined {
    return undefined;
  }

  composeFrom(_agentCtx: Context, _parentCtx: Context): undefined {
    return undefined;
  }

  composedPreset(_agentCtx: Context): string | undefined {
    return OMP_PRESET.id;
  }

  async standingKeyFor(id?: string): Promise<ScopeKey> {
    await this.resolve(id);
    return STANDING_KEY;
  }
}
