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
import type { WorkspaceRegistry } from "@deepseek-ai/dsh-workspace";
import { OmpRpcClient } from "./rpc.js";
import { OmpAgent } from "./agent.js";
import { replayOmpMessages } from "./replay.js";
import { sessionIndex } from "./session-index.js";
import { OmpLlmAdapter } from "./adapter.js";
import { OmpUnionSessionPersistence } from "./session-persistence-omp.js";
import { SingleOmpPresetRoster } from "./agent-preset-omp.js";
import { cwdFromSessionFile, OMP_SESSIONS_ROOT, scanOmpSessions } from "./omp-store.js";
import { defaultPermissionPreset, envApprovalMode, ompApprovalMode, presetFromEvents, readWebuiPreset, writeWebuiPreset } from "./permission.js";
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
    this.#reconcileWorkspaces();
  }

  /**
   * Derive the Workspace sidebar from the scanned OMP cwds. The registry
   * bootstraps from `sessionPersistence.list()` only once (its durable state
   * is already initialized), so native-only workspaces are created and their
   * sessions attached here — idempotently, on every boot. cwds under the OMP
   * home itself stay ungrouped: those records are deleted when present, which
   * leaves their sessions as sidebar strays in the "Ungrouped" bucket.
   */
  #reconcileWorkspaces(): void {
    this.runtime.ctx.inject(["workspaceRegistry"], async (wctx) => {
      const registry = (wctx as unknown as { workspaceRegistry: WorkspaceRegistry }).workspaceRegistry;
      try {
        const ungroupedPaths = new Set(
          [process.env.OMP_HOME ?? join(homedir(), ".omp"), process.env.DSH_HOME ?? join(homedir(), ".omp/dsh")]
            .map((path) => realpathSync(path))
            .filter((path) => path !== undefined),
        );
        const groups = new Map<string, string[]>();
        for (const entry of scanOmpSessions().values()) {
          if (entry.cwd === undefined) continue;
          let canonical: string | undefined;
          try {
            canonical = realpathSync(entry.cwd);
            if (!statSync(canonical).isDirectory()) canonical = undefined;
          } catch {
            canonical = undefined;
          }
          if (canonical === undefined || ungroupedPaths.has(canonical)) continue;
          const ids = groups.get(canonical);
          if (ids === undefined) groups.set(canonical, [entry.ompSessionId]);
          else if (!ids.includes(entry.ompSessionId)) ids.push(entry.ompSessionId);
        }
        for (const [path, ids] of groups) {
          const existing = await registry.resolveByPath(path);
          const workspace = existing ?? (await registry.create(path));
          for (const id of ids) {
            if (!workspace.sessionIds.some((accounted) => accounted === (id as never))) {
              await workspace.attachSession(id as never);
            }
          }
        }
        for (const workspace of registry.list()) {
          // Prune any registry workspace the current scan no longer backs:
          // OMP-home paths (ungrouped by design) and paths with zero scanned
          // sessions (test workspaces whose transcripts were deleted on disk).
          // Without this the persisted registry keeps showing stale entries.
          if (ungroupedPaths.has(workspace.path) || !groups.has(workspace.path)) {
            await registry.delete(workspace.id);
          }
        }
      } catch (error) {
        wctx.logger.warn(`omp-provider: workspace reconciliation failed: ${String(error)}`);
      }
    });
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
      // Capture OMP's session identity so resume can recover it later.
      const state = await rpc.getState();

      if (state.sessionId !== undefined && state.sessionFile !== undefined) {
        await sessionIndex.put(id, {
          ompSessionId: state.sessionId,
          ompSessionFile: state.sessionFile,
          ...(cwd === undefined ? {} : { cwd }),
          createdAt: Date.now(),
        });

        // Persist the Dash-side preset next to OMP's transcript: cold reads
        // synthesize the permission events from it after wrapper restarts,
        // and resume re-derives the spawn flag. Best-effort by contract.
        if (preset !== undefined) writeWebuiPreset(state.sessionFile, preset);
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

    // Recover the OMP session identity recorded at createAgent time (or seeded
    // from the store scan for TUI-created sessions).
    const record = sessionIndex.get(id);
    trace(`resume id=${id} record=${record === undefined ? "MISSING" : record.ompSessionFile}`);
    if (record === undefined) {
      throw new Error(`cannot resume session "${id}": no OMP session is recorded for this Dash session id`);
    }

    // The session file must live inside OMP's native store — the mapping JSON
    // is user-writable, so its path field alone must not aim a resume at an
    // arbitrary file outside the store.
    let sessionFile: string;
    try {
      sessionFile = realpathSync(record.ompSessionFile);
      if (!sessionFile.startsWith(`${realpathSync(OMP_SESSIONS_ROOT)}/`)) {
        throw new Error("outside the OMP session store");
      }
    } catch (error) {
      throw new Error(`cannot resume session "${id}": recorded OMP session file is unusable (${String(error)})`);
    }

    // Refuse to spawn OMP for a session this profile's persistence does not
    // serve (the scan must still list it — files deleted out from under the
    // mapping must not be resumable).
    const persistence = loopCtx.get("sessionPersistence") as SessionPersistenceSlice | undefined;
    const persisted =
      persistence !== undefined && (await persistence.list()).some((header) => header.id === id);
    trace(`resume id=${id} persisted=${persisted}`);
    // Spawn cwd is derived from the session's LOCATION in OMP's store (the
    // dashed parent directory), never the mapping's verbatim cwd field; the
    // header-record cwd (also OMP-authored, inside the file) is the fallback
    // for stores whose directory names predate the flattening convention.
    const scanEntry = scanOmpSessions().get(id);
    const spawnCwd = cwdFromSessionFile(sessionFile) ?? validatedCwd(scanEntry?.cwd);
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
      // union persistence (scan → readMessages → replay). There is no
      // Dash-side log anymore — the replay IS the stored history, so it can
      // never mismatch a persisted prefix. A missing persistence service
      // (never in this profile) falls back to replaying via live RPC.
      const preparation =
        persistence !== undefined
          ? await persistence.prepare(id, options.signal)
          : SessionPreparation.create(loopCtx.sessions.prepare(id, {
              seed: replayOmpMessages(await rpc.getMessages()),
              meta: {
                ...(spawnCwd === undefined ? {} : { cwd: spawnCwd }),
                createdAt: record.createdAt,
              },
            }));
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
