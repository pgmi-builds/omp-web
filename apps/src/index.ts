/**
 * dsh-omp-provider — OMP provider plugin for DeepSeek Harness.
 *
 * Replaces the built-in agent loop with an `AgentFactory` that spawns
 * `omp --mode rpc` and bridges OMP's RPC stream into the Dash Agent/Session
 * contracts. Mirrors `@deepseek-ai/dsh-agent-loop`'s creation transaction
 * (prepare → setup → publish) so the session + agent publish as one ordered
 * lifecycle.
 *
 * Phase 3 adds resume:
 *   - `createAgent` records the Dash→OMP session identity in `OmpSessionIndex`
 *     (OMP owns the transcript, Dash owns the live identity).
 *   - `resume` re-spawns `omp --mode rpc --resume <sessionFile>` and restores
 *     the persisted Dash session log (`sessionPersistence.prepare`), so the
 *     Web UI's cold listing/history/follow-up path (`session.list`,
 *     `session.history`, `session.prompt` → `agents.resume`) reopens the
 *     exact transcript it rendered before the restart. The OMP transcript is
 *     replayed (`get_messages`) only when no Dash log was persisted.
 */
import { realpathSync, statSync } from "node:fs";
import { Context, Service } from "@deepseek-ai/cordis";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  AgentFactory,
  AgentHandle,
  AgentOptions,
  AgentSetup,
  CreateAgentOptions,
  ResumeAgentOptions,
} from "@deepseek-ai/dsh-agent";
import { emitAgentEvent } from "@deepseek-ai/dsh-agent";
import { SessionPreparation, type SessionEvent, type SessionId } from "@deepseek-ai/dsh-session";
import type { LlmRuntime } from "@deepseek-ai/dsh-llm";
import { OmpRpcClient } from "./rpc.js";
import { OmpAgent } from "./agent.js";
import { replayOmpMessages } from "./replay.js";
import { OmpLlmAdapter } from "./adapter.js";
import { OmpUnionSessionPersistence } from "./session-persistence-omp.js";
import { SingleOmpPresetRoster } from "./agent-preset-omp.js";
import { cwdFromSessionFile, OMP_SESSIONS_ROOT, scanOmpSessions } from "./omp-store.js";
import { defaultPermissionPreset, envApprovalMode, ompApprovalMode, presetFromEvents, readWebuiPreset, writeWebuiArtifact } from "./permission.js";
import { ompProviderIds } from "./models.js";

/** Realpath of a recorded cwd, accepted only when it names an existing directory. */
function validatedCwd(cwd: string | undefined): string | undefined {
  if (cwd === undefined) return undefined;
  try {
    const canonical = realpathSync(cwd);
    return statSync(canonical).isDirectory() ? canonical : undefined;
  } catch {
    return undefined;
  }
}

/** Diagnostic trace (OMP_TRACE=1 on the dsh process enables stderr tracing). */
const trace = (...parts: unknown[]): void => {
  if (process.env.OMP_TRACE === "1") process.stderr.write(`[omp-provider ${Date.now() % 1_000_000}] ${parts.join(" ")}\n`);
};

/**
 * The slice of `ctx.sessionPersistence` (dsh-session-persistence) resume
 * depends on. Typed locally so the plugin needs no dependency on the
 * persistence package; the runtime contract is stable (`load` returns the
 * durable log, `prepare` restores it as an unpublished `SessionPreparation`).
 */
interface SessionPersistenceSlice {
  list(signal?: AbortSignal): Promise<{ id: string }[]>;
  load(id: SessionId): Promise<{ events: SessionEvent[] }>;
  prepare(id: SessionId, signal?: AbortSignal): Promise<SessionPreparation>;
}

export class OmpProvider extends Service implements AgentFactory {
  static inject: string[] = ["agents", "sessions", "llm"];

  /** Plain holder — prevents Cordis re-tracing the factory's ctx through a caller shadow. */
  private readonly runtime: { ctx: Context };

  constructor(ctx: Context) {
    super(ctx, "ompProvider");
    this.runtime = { ctx };
    ctx.effect(() => ctx.agents.setFactory(this), "ompProvider.setFactory()");
    this.#registerModelCatalog();
    // Phase B surfaces: the union persistence (Dash JSONL logs ⊕ OMP's native
    // store scan) serves session.list / cold history / resume ownership, and
    // the single-preset roster puts one "OMP" entry on the mode dropdown and
    // the Settings → Agent Preset tab. Both self-register on child fibers, so
    // they load with this plugin — before any dependent service initializes.
    ctx.plugin(OmpUnionSessionPersistence);
    ctx.plugin(SingleOmpPresetRoster);
  }

  /**
   * Register the OMP-backed LLM adapter so the browser model selector (an RPC
   * round-trip through the apiproxy reading `ctx.llm.*`) advertises OMP's real
   * providers and models. The registration is tied to the LLM runtime's own
   * lifecycle, mirroring `llm-deepseek`/`llm-pi-ai` (which the profile disables).
   */
  #registerModelCatalog(): void {
    const llm = this.runtime.ctx.get("llm") as LlmRuntime | undefined;
    if (llm === undefined) return;
    const providers = ompProviderIds();
    if (providers.length === 0) {
      this.runtime.ctx.logger.warn("omp-provider: no OMP models discovered; the model selector will be empty");
      return;
    }
    llm.registerAdapter(providers, new OmpLlmAdapter());
  }

  async createAgent(ownerCtx: Context, options: CreateAgentOptions): Promise<AgentHandle> {
    const loopCtx = this.runtime.ctx;
    const id = options.sessionId;
    const meta = options.meta ?? {};
    const cwd = meta.cwd;

    // Approval policy is pinned at OMP launch and the Dash session does not
    // exist yet at this point (it is prepared + announced — which is what
    // stamps `permission/preset` via pinInitialPermission — only inside
    // setupAndPublish, AFTER this spawn), so the effective preset cannot
    // come from session events: read the permission service's default and
    // map it onto the launch flag. OMP_APPROVAL_MODE (headless runs) wins.
    const envMode = envApprovalMode();
    const preset = defaultPermissionPreset(loopCtx);
    const approvalMode = envMode ?? ompApprovalMode(preset);
    trace(`create id=${id} preset=${preset ?? "none"} approval-mode=${approvalMode}${envMode === undefined ? "" : " (env override)"}`);

    // Spawn OMP and wait for the `ready` handshake.
    const rpc = await OmpRpcClient.spawn(["--approval-mode", approvalMode], cwd);

    try {
      // The Dash session id and OMP's session id are UNRELATED (Dash mints
      // `session-<uuid4>`, OMP its own uuidv7). Their pairing lives in the one
      // per-session artifact the bridge owns inside OMP's store (webui.json):
      // a Dash-id resume reads it back through the scan, and the preset
      // travels with it for cold permission synthesis. Best-effort contract.
      const state = await rpc.getState();

      if (state.sessionFile !== undefined) {
        writeWebuiArtifact(state.sessionFile, { dashSessionId: id, ...(preset === undefined ? {} : { preset }) });
      }

      // Prepare the unpublished session (mirrors dsh-agent-loop's SessionPreparation).
      const preparation = SessionPreparation.create(loopCtx.sessions.prepare(id, {
        ...(options.seed === undefined ? {} : { seed: options.seed }),
        ...(meta === undefined ? {} : { meta }),
      }));

      const handle = await setupAndPublish(loopCtx, ownerCtx, id, options.agentOptions ?? {}, options.setup, preparation, rpc, "startup");

      return handle;
    } catch (error) {
      rpc.close();
      throw error;
    }
  }

  async resume(ownerCtx: Context, options: ResumeAgentOptions): Promise<AgentHandle> {
    const loopCtx = this.runtime.ctx;
    const id = options.resumeSessionId;

    // Identity (dev_0.0.3): the store scan is the single source of truth.
    // Every resumable id IS an OMP id — the API resolver only routes ids the
    // persistence lists (which the scan feeds), so a miss here is a genuine
    // unknown, fail-closed. Dash-minted ids (`session-<uuid4>`) are rejected
    // upstream with `session-not-found` before this point; their OMP
    // sessions stay resumable under the OMP id the list shows.
    const record = scanOmpSessions().get(id);
    trace(`resume id=${id} record=${record === undefined ? "MISSING" : record.ompSessionFile}`);
    if (record === undefined) {
      throw new Error(`cannot resume session "${id}": no OMP session is recorded for this Dash session id`);
    }

    // The session file must live inside OMP's native store — the scanned
    // entry's path is OMP-authored, but re-realpath and re-verify so a store
    // mutated underneath the scan cannot aim a resume outside it.
    let sessionFile: string;
    try {
      sessionFile = realpathSync(record.ompSessionFile);
      if (!sessionFile.startsWith(`${realpathSync(OMP_SESSIONS_ROOT)}/`)) {
        throw new Error("outside the OMP session store");
      }
    } catch (error) {
      throw new Error(`cannot resume session "${id}": recorded OMP session file is unusable (${String(error)})`);
    }

    // The union persistence serves exactly the ids the scan lists, so this
    // resume is always persistence-served in this profile; the RPC-replay
    // branch below only guards a persistence-less composition.
    const persistence = loopCtx.get("sessionPersistence") as SessionPersistenceSlice | undefined;
    // Spawn cwd is derived from the session's LOCATION in OMP's store (the
    // dashed parent directory), never the mapping's verbatim cwd field; the
    // header-record cwd (also OMP-authored, inside the file) is the fallback
    // for stores whose directory names predate the flattening convention.
    const spawnCwd = cwdFromSessionFile(sessionFile) ?? validatedCwd(record.cwd);
    if (spawnCwd === undefined) {
      throw new Error(`cannot resume session "${id}": its recorded working directory no longer exists`);
    }
    trace(`resume id=${id} spawnCwd=${spawnCwd}`);

    // Approval mode for the re-attached child: launch-only, so it is decided
    // BEFORE the spawn from the bridge's persisted preset (webui.json),
    // falling back to the replayed session log (which carries the
    // synthesized permission events for wrapper-created sessions).
    // OMP_APPROVAL_MODE (headless runs) overrides; no preset → native yolo.
    const envMode = envApprovalMode();
    const preset =
      readWebuiPreset(sessionFile) ??
      (persistence !== undefined
        ? presetFromEvents((await persistence.load(id)).events)
        : undefined);
    const approvalMode = envMode ?? ompApprovalMode(preset);
    trace(`resume id=${id} preset=${preset ?? "none"} approval-mode=${approvalMode}${envMode === undefined ? "" : " (env override)"}`);

    // Re-attach to the OMP session by its persisted file (OMP owns the live
    // agent transcript and keeps generating it from here on).
    const rpc = await OmpRpcClient.spawn(["--approval-mode", approvalMode, "--resume", sessionFile], spawnCwd);

    try {
      // Seed the Dash session log by replaying the OMP transcript through the
      // union persistence (scan → readMessages → replay); a persistence-less
      // composition (never in this profile) falls back to live-RPC replay.
      const preparation = await (persistence !== undefined
        ? persistence.prepare(id, options.signal)
        : SessionPreparation.create(loopCtx.sessions.prepare(id, {
            seed: replayOmpMessages(await rpc.getMessages()),
            meta: {
              ...(spawnCwd === undefined ? {} : { cwd: spawnCwd }),
              createdAt: record.createdAt,
            },
          })));
      trace(`resume id=${id} replayed transcript from OMP store`);

      return await setupAndPublish(loopCtx, ownerCtx, id, options.agentOptions ?? {}, options.setup, preparation, rpc, "resume");
    } catch (error) {
      rpc.close();
      throw error;
    }
  }

}

/**
 * Shared creation/resume transaction: build the agent over the prepared
 * session, run unpublished setup, and publish both in order. Kept as a
 * module-level function (not a private method) because Cordis exposes the
 * provider through a tracing proxy, which breaks hard-private (`#`) receivers.
 */
async function setupAndPublish(
  loopCtx: Context,
  ownerCtx: Context,
  id: SessionId,
  agentOptions: AgentOptions,
  setup: AgentSetup | undefined,
  preparation: SessionPreparation,
  rpc: OmpRpcClient,
  source: "startup" | "resume",
): Promise<AgentHandle> {
  let detachSession: (() => void) | undefined;
  let detachAgent: (() => void) | undefined;
  let agent: OmpAgent | undefined;
  // Late-bound teardown the agent triggers itself after its idle window
  // expires (see OmpAgent's idle exit) — defined only after publication.
  let idleExit: (() => void) | undefined;
  try {
    // Build the agent shim over the prepared session and the live RPC client.
    agent = new OmpAgent(loopCtx, id, agentOptions, preparation.session, rpc, () => idleExit?.());

    // Composition-only setup on the unpublished agent scope.
    const commit = await setup?.(agent.ctx);

    // Publish: enter both session and agent, announce in order, then signal
    // session-start. The commit runs immediately before publication.
    commit?.commit();

    detachSession = agent.ctx.sessions.enter(preparation.session);
    detachAgent = loopCtx.agents.enter(agent, ownerCtx.agent);
    agent.ctx.sessions.announce(preparation.session);
    loopCtx.agents.announce(agent);
    emitAgentEvent(loopCtx, agent, "agent/session-start", { source });

    let disposed = false;
    let unfollowOwner: (() => void) | undefined;
    const dispose = async (): Promise<void> => {
      if (disposed) return;
      disposed = true;
      unfollowOwner?.();
      await agent?.dispose();
      detachAgent?.();
      detachSession?.();
    };
    idleExit = () => void dispose();

    // Follow the owner: a caller-fiber unload tears this agent down.
    unfollowOwner = ownerCtx.effect(() => () => {
      void dispose();
    }, `ompProvider.lifecycle(${id})`);

    return { agent, dispose };
  } catch (error) {
    // Unwind the half-published transaction. A failure between `enter` and
    // the announcements (e.g. a persistence listener rejecting the session)
    // must not leave a live-but-dead entry the API resolver would serve.
    detachAgent?.();
    detachSession?.();
    void agent?.dispose().catch(() => {});
    rpc.close();
    throw error;
  } finally {
    // Release the preparation's per-id reservation on every path (mirrors
    // the reference loop's unconditional dispose): the session it seeded is
    // already published above, so a same-process re-resume of this id can
    // prepare again instead of colliding with a leaked reservation.
    preparation[Symbol.dispose]();
  }
}

export default OmpProvider;
