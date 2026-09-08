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
import { type Context } from "@deepseek-ai/cordis";
import { Remote, RemoteError, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { type Agent } from "@deepseek-ai/dsh-agent";
import {
  type AgentPreset,
  type AgentPresetDocument,
  type AgentPresetRoster,
} from "@deepseek-ai/dsh-agent-presets";
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

export class SingleOmpPresetRoster extends TypertRemoteService {
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
    throw new RemoteError("agent-preset/not-found", `agent-presets: preset "${id}" not found (available: omp)`, { agentPreset: id, available: [OMP_PRESET.id] });
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

  // ── Remote RPC surface (alpha: agentPresets routes come from @Remote) ────
  // The stock dsh-host-apiproxy mapped cordis methods to routes; alpha serves
  // them from @Remote decorators on a TypertRemoteService. A plain Service
  // registers no routes, which is why Settings → Agent Preset 404'd.

  @Remote("list")
  async remoteList(): Promise<AgentPresetRoster> {
    if (process.env.OMP_TRACE === "1") process.stderr.write("[omp-roster] remoteList INVOKED\n");
    return {
      presets: [
        {
          id: OMP_PRESET.id,
          trust: OMP_PRESET.trust,
          isDefault: true,
          name: OMP_PRESET.name,
          description: OMP_PRESET.description,
        },
      ],
      authorable: this.authorable,
    };
  }

  @Remote("read")
  async remoteRead(agentPreset: string): Promise<AgentPresetDocument> {
    const preset = await this.resolve(agentPreset);
    return {
      agentPreset: preset.id,
      trust: preset.trust,
      content: await this.read(preset.id),
      name: preset.name,
      description: preset.description,
    };
  }

  @Remote("copy")
  async remoteCopy(from: string, id: string, name?: string): Promise<void> {
    await this.copy(from, id, name);
  }

  @Remote("deletePreset")
  async remoteDelete(id: string): Promise<void> {
    await this.remove(id);
  }

  /** Fixed roster: one preset, so selecting it is a no-op ack; anything else is unknown. */
  @Remote("select")
  async remoteSelect(agent: Agent, agentPreset: string): Promise<string> {
    const preset = await this.resolve(agentPreset);
    return preset.id;
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
