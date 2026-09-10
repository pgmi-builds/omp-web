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
  Agent,
  AgentFactory,
  AgentHandle,
  AgentOptions,
  AgentSetup,
  CreateAgentOptions,
  ResumeAgentOptions,
} from "@deepseek-ai/dsh-agent";
import { emitAgentEvent } from "@deepseek-ai/dsh-agent";
import { SessionPreparation, type Session, type SessionEvent, type SessionId } from "@deepseek-ai/dsh-session";
import type { LlmRuntime } from "@deepseek-ai/dsh-llm";
import { createSystemMessage } from "@deepseek-ai/dsh-llm";
import { OmpSdkClient } from "./sdk-client.js";
import { OmpAgent } from "./agent.js";
import { replayOmpMessages } from "./replay.js";
import { OmpLlmAdapter } from "./adapter.js";
import { OmpUnionSessionPersistence } from "./session-persistence-omp.js";
import { SingleOmpPresetRoster } from "./agent-preset-omp.js";
import { ompAgentPresetProjection } from "./agent-preset-projection.js";
import { resolveEntryById } from "./pairing.js";
import { cwdFromSessionFile, foreignWriterPid, OMP_SESSIONS_ROOT, parseSelector as parseModelSelector, sessionHeaderId } from "./omp-store.js";
import { supervisor } from "./supervisor.js";
import { ompModelRoles, ompSetModelRoles } from "./omp-cli.js";
import { ompProviderIds, refreshOmpModelsCli } from "./models.js";
import { STORAGE_RECONCILE_INTERVAL_MS } from "./knobs.js";
import { defaultPermissionPreset, envApprovalMode, ompApprovalMode, presetFromEvents } from "./permission.js";
import { closeBridgeStore, getBridgeStore, initBridgeStore } from "./store/index.js";
import { reconcileOnce, syncSessionHeader, upsertCreated } from "./store/reconcile.js";
import { installMobileBootScript } from "./mobile-boot.js";

/** Bounded grace for avoidance hand-off: abort then wait this long before forced teardown. */
const AVOIDANCE_GRACE_MS = 10_000;

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
 * The slice of `ctx.sessionPersistence` (dsh-session-persistence v2) resume
 * depends on. Typed locally so the plugin needs no dependency surface beyond
 * the handle read: `open(id, "read")` + `handle.read()` restore the durable
 * log — the v2 replacement for the removed `load`/`prepare` pair.
 */
interface SessionPersistenceSlice {
  open(
    id: SessionId,
    access: "read",
    options?: { signal?: AbortSignal },
  ): Promise<{ read(): Promise<{ events: SessionEvent[] }>; close(): Promise<void> }>;
}

/** Open a read handle, pull the complete stored log, close. */
async function readStoredEvents(
  persistence: SessionPersistenceSlice,
  id: SessionId,
  signal?: AbortSignal,
): Promise<SessionEvent[]> {
  const handle = await persistence.open(id, "read", signal === undefined ? undefined : { signal });
  try {
    return [...(await handle.read()).events];
  } finally {
    await handle.close();
  }
}

/** The slice of `ctx.workspaceRegistry` the boot workspace-reconcile reads. */
interface WorkspaceEntitySlice {
  readonly id: string;
  readonly path: string;
  readonly sessionIds: readonly string[];
  attachSession(sessionId: string): Promise<void>;
}
interface WorkspaceRegistrySlice {
  resolveByPath(path: string): Promise<WorkspaceEntitySlice | undefined>;
  create(path: string, title?: string): Promise<WorkspaceEntitySlice>;
  list(): WorkspaceEntitySlice[];
}

export class OmpProvider extends Service implements AgentFactory {
  static inject: string[] = ["agents", "sessions", "llm"];

  /** Plain holder — prevents Cordis re-tracing the factory's ctx through a caller shadow. */
  private readonly runtime: { ctx: Context };
  /** Stops the supervisor's follow loop on provider teardown. */
  private stopFollow: () => void = () => {};
  /** Live RPC-backed agents by dash id, for avoidance hand-off. */
  private readonly heldAgents = new Map<string, AgentHandle>();
  /** Shadow of OMP's `modelRoles.default` (`provider/model`) seen last tick. */
  #ompDefaultKey = "";
  /** Shadow of DSH's agentDefaultModel selection (`provider/model`) seen last tick. */
  #dshSelectionKey = "";

  constructor(ctx: Context) {
    super(ctx, "ompProvider");
    this.runtime = { ctx };
    ctx.effect(() => ctx.agents.setFactory(this), "ompProvider.setFactory()");
    this.#registerModelCatalog();
    // Boot the centralized index BEFORE any service reads session state: warm
    // pass + migration, so the first landing sees real titles/models (D5.1).
    initBridgeStore();
    void this.#syncModelDefaultTick();
    // Phase B surfaces: the union persistence (Dash JSONL logs ⊕ OMP's native
    // store scan) serves session.list / cold history / resume ownership, and
    // the single-preset roster puts one "OMP" entry on the mode dropdown and
    // the Settings → Agent Preset tab. Both self-register on child fibers, so
    // they load with this plugin — before any dependent service initializes.
    ctx.plugin(OmpUnionSessionPersistence);
    // The roster must be visible to the API gateway's root-level remote
    // enumeration (dsh-host-apiproxy read it from the root service table);
    // nesting it under a child fiber via ctx.plugin hides its @Remote routes
    // from the gateway and every agentPresets/* call 404s. Register it on
    // this plugin's own (top-level) fiber instead — its Service constructor
    // ties teardown to this fiber via reflect.provide.
    new SingleOmpPresetRoster(ctx);
    // Drive the `agentPreset` session projection ourselves: the upstream
    // registrant lives in the (disabled) dsh-agent-presets package, but the
    // Web UI gates the preset chip and header label on
    // `projectionValues.agentPreset`. Deferred via inject so the registry's
    // service contract is honored (registers only once it exists).
    ctx.inject(["sessionProjections"], (scoped: Context) => {
      scoped.sessionProjections.register(ompAgentPresetProjection);
    });
    // Session supervisor: state machine + cold projection + foreign detection.
    // `ctx.logger` output is not captured by the systemd journal in this
    // profile; supervisor events are load-bearing (avoidance), so mirror them
    // to stderr — the only channel guaranteed to reach the operator log.
    supervisor.attach(this.runtime.ctx.sessions, (msg) => {
      const line = `[omp-supervisor] ${msg}`;
      this.runtime.ctx.logger.info(line);
      process.stderr.write(`${line}\n`);
    });
    supervisor.reconcile();
    this.stopFollow = supervisor.startFollow();
    supervisor.onAvoidance((id) => void this.handleAvoidance(id));
    ctx.effect(() => () => this.stopFollow(), "ompProvider.followStop()");
    ctx.effect(() => () => closeBridgeStore(), "ompProvider.storeClose()");
    this.#reconcileWorkspaces();
    // Mobile page-config boot script (host half): sets `window.__OMP_WEB_MOBILE__`
    // + the iOS zoom-guard section. Fail-open — a missing webServer leaves the
    // feature dormant, and an injection failure is logged, never thrown.
    installMobileBootScript(ctx);
  }

  /**
   * Two-way default-model sync, evaluated once per reconcile tick (and once
   * at boot): OMP's `modelRoles.default` (CLI) ↔ DSH's `agentDefaultModel`
   * selection. TUI semantics on both sides — a default write survives
   * sessions. Direction is decided by shadow keys: whichever side moved
   * since the last tick wins, and an echo (same value round-tripping back)
   * is a no-op.
   */
  async #syncModelDefaultTick(): Promise<void> {
    const service = this.runtime.ctx.get("agentDefaultModel") as
      | {
          currentSelection?: () => { provider: string; model: string };
          saveSelection?: (selection: { provider: string; model: string }) => Promise<unknown>;
        }
      | undefined;
    const roles = await ompModelRoles();
    const ompSelector = roles?.default;
    const ompParsed = ompSelector === undefined ? undefined : parseModelSelector(ompSelector);
    const ompKey = ompParsed === undefined ? undefined : `${ompParsed.provider}/${ompParsed.model}`;
    const dsh = service?.currentSelection?.();
    const dshKey = dsh === undefined ? undefined : `${dsh.provider}/${dsh.model}`;
    try {
      if (ompKey !== undefined && ompKey !== this.#ompDefaultKey) {
        // OMP side moved (TUI default switch or config edit): carry it into
        // the store and the DSH default so new Web sessions inherit it.
        this.#ompDefaultKey = ompKey;
        if (ompParsed !== undefined) {
          getBridgeStore()?.setOmpDefaultModel(ompParsed.provider, ompParsed.model);
          await service?.saveSelection?.({ provider: ompParsed.provider, model: ompParsed.model });
          this.#dshSelectionKey = ompKey;
          this.runtime.ctx.logger.info(`omp-provider: default model ← OMP: ${ompKey}`);
        }
      } else if (dshKey !== undefined && dshKey !== this.#dshSelectionKey) {
        // DSH side moved (Web UI selector switch): propagate into OMP's
        // modelRoles.default through the CLI so TUI sessions inherit it.
        this.#dshSelectionKey = dshKey;
        if (dsh !== undefined && dshKey !== this.#ompDefaultKey) {
          const next = { ...(roles ?? {}), default: `${dsh.provider}/${dsh.model}` };
          if (await ompSetModelRoles(next)) {
            this.#ompDefaultKey = dshKey;
            this.runtime.ctx.logger.info(`omp-provider: default model → OMP: ${dshKey}`);
          } else {
            this.runtime.ctx.logger.warn(`omp-provider: default model → OMP write failed: ${dshKey}`);
          }
        }
      }
    } catch (error) {
      this.runtime.ctx.logger.warn(`omp-provider: default model sync failed: ${String(error)}`);
    }
  }


  /**
   * Reconcile the Web UI workspace sidebar against the scanned OMP store.
   *
   * The upstream workspace registry (`dsh-workspace`) only auto-groups by cwd
   * on its FIRST boot (`bootstrap`); every session appearing later is grouped
   * solely by `workspace.attachSession`, which the apiproxy calls only during
   * `create`. TUI-born OMP sessions never pass through `create`, so without
   * this pass they land in the "Ungrouped" bucket even though their cwd is
   * durable in the transcript. Attach each scanned session by its DASH-facing
   * id (dev_0.0.3 §11: OMP ids never cross the bridge boundary) to the
   * workspace owning its canonical cwd — idempotent, fail-soft, every boot.
   */
  #reconcileWorkspaces(): void {
    this.runtime.ctx.inject(["workspaceRegistry"], (wctx) => {
      const registry = wctx.get("workspaceRegistry") as WorkspaceRegistrySlice | undefined;
      if (registry === undefined) return;
      const run = (): void => {
        const store = getBridgeStore();
        if (store !== undefined) reconcileOnce(store);
        void this.#syncModelDefaultTick();
        void refreshOmpModelsCli();
        void this.#attachScannedSessions(registry);
        supervisor.reconcile();
      };
      run();
      // The registry groups by cwd only at ITS boot, so TUI-side sessions
      // created later (the store gains files at any time) would sit in
      // "Ungrouped" forever. Re-attach periodically: idempotent, fail-soft,
      // and the scan is a stat pass over the store.
      const timer = setInterval(run, STORAGE_RECONCILE_INTERVAL_MS);
      timer.unref();
      wctx.effect(() => () => clearInterval(timer), "ompProvider.reconcileTimer()");
    });
  }

  /** One idempotent attach pass: every scanned session joins the workspace owning its canonical cwd. */
  async #attachScannedSessions(registry: WorkspaceRegistrySlice): Promise<void> {
    try {
      const excluded = new Set<string>();
      for (const home of [
        process.env.OMP_HOME ?? join(homedir(), ".omp"),
        process.env.DSH_HOME ?? join(homedir(), ".omp", "dsh"),
      ]) {
        try {
          excluded.add(realpathSync(home));
        } catch {
          // Unresolvable home: nothing to exclude.
        }
      }
      const groups = new Map<string, string[]>();
      const store = getBridgeStore();
      if (store === undefined) return;
      for (const row of store.list()) {
        const cwd = validatedCwd(row.cwd ?? undefined);
        if (cwd === undefined || excluded.has(cwd)) continue;
        const id = row.dsh_session_id;
        const ids = groups.get(cwd);
        if (ids === undefined) groups.set(cwd, [id]);
        else if (!ids.includes(id)) ids.push(id);
      }
      for (const [path, ids] of groups) {
        const workspace = (await registry.resolveByPath(path)) ?? (await registry.create(path));
        for (const id of ids) {
          if (!workspace.sessionIds.includes(id)) await workspace.attachSession(id);
        }
      }
    } catch (error) {
      this.runtime.ctx.logger.warn(`omp-provider: workspace reconciliation failed: ${String(error)}`);
    }
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

    // Fork (the apiproxy's `session.fork`) seeds a copied-turn prefix but OMP
    // has no native fork: the child spawned below would start with an EMPTY
    // context while the UI renders the copied history, and after a restart
    // even that history would vanish (OMP's transcript holds only post-fork
    // traffic). Fail the fork cleanly at the factory boundary instead of
    // splitting the two surfaces. `parentSession` in create metadata is set
    // only by the fork path (subagents go through ctx.subagents instead).
    if (meta.parentSession !== undefined) {
      throw new Error(
        `cannot fork session "${meta.parentSession}" onto the OMP provider: OMP has no native session fork`,
      );
    }

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
    const rpc = await OmpSdkClient.spawn(["--approval-mode", approvalMode], cwd);

    try {
      // The Dash session id and OMP's session id are UNRELATED (Dash mints
      // `session-<uuid4>`, OMP its own uuidv7). Their pairing lives in the one
      // per-session artifact the bridge owns inside OMP's store (webui.json):
      // a Dash-id resume reads it back through the scan, and the preset
      // travels with it for cold permission synthesis. Best-effort contract.
      const state = await rpc.getState();

      // Prepare the unpublished session FIRST (mirrors dsh-agent-loop's
      // SessionPreparation): its stamped header is the single source of truth
      // for the row below. v2 folds header identity across live/listed/loaded
      // observations, so a row created_at from an independent Date.now() call
      // would make every session/list observation conflict with the live one.
      const preparation = SessionPreparation.create(loopCtx.sessions.prepare(id, {
        ...(options.seed === undefined ? {} : { seed: options.seed }),
        ...(meta === undefined ? {} : { meta }),
      }));

      if (state.sessionFile !== undefined) {
        const store = getBridgeStore();
        if (store !== undefined) {
          const ompId = state.sessionId ?? sessionHeaderId(state.sessionFile);
          if (ompId !== undefined) {
            upsertCreated(store, {
              ompSessionId: ompId,
              sessionFile: state.sessionFile,
              dshSessionId: id,
              createdAt: preparation.session.header.createdAt,
              cwd: preparation.session.header.cwd ?? cwd,
              ...(preset === undefined ? {} : { preset }),
            });
          }
        }
      }

      const handle = await setupAndPublish(loopCtx, ownerCtx, id, options.agentOptions ?? {}, options.setup, preparation.session, rpc, options.parentAgent, "startup", { enterSession: true, preparation });

      return this.registerHeld(id, state.sessionFile ?? "", handle);
    } catch (error) {
      rpc.close();
      throw error;
    }
  }

  async resume(ownerCtx: Context, options: ResumeAgentOptions): Promise<AgentHandle> {
    const loopCtx = this.runtime.ctx;
    const id = options.resumeSessionId;
    // L1: a session mid-avoidance must not receive prompts (the RPC is being
    // handed off to the TUI; feeding it a prompt races the teardown).
    if (supervisor.isAvoiding(id)) {
      throw new Error(`cannot resume session "${id}": hand-off to the TUI is in progress`);
    }

    // Identity (dev_0.0.3 §11): translate the Dash-facing id (real Dash id
    // via the webui.json pairing, or a stateless derived id) back to its
    // scanned OMP entry. The API resolver only routes ids the persistence
    // lists — which are exactly these Dash-facing ids — so a miss here is a
    // genuine unknown, fail-closed.
    const record = resolveEntryById(id);
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
      getBridgeStore()?.byDshId(String(id))?.permission_preset ??
      (persistence !== undefined
        ? presetFromEvents(await readStoredEvents(persistence, id, options.signal))
        : undefined);
    const approvalMode = envMode ?? ompApprovalMode(preset);
    trace(`resume id=${id} preset=${preset ?? "none"} approval-mode=${approvalMode}${envMode === undefined ? "" : " (env override)"}`);

    // Exclusive hold, L2 (pre-spawn). OMP has no session-level or file-level
    // locking (a TUI `omp` and a bridge `--mode rpc --resume` otherwise
    // interleave appends on one transcript). omp 18's writer opens the file
    // per write and closes it, so a /proc fd scan cannot see an idle TUI;
    // the fd check is kept as a free strong signal, and a hot mtime (<2s)
    // catches a TUI mid-generation. An idle TUI is undetectable here by
    // design — the held-state content watch (≤ FILE_FOLLOW_INTERVAL_MS)
    // detects its first prompt and avoids.
    const holder = foreignWriterPid(sessionFile);
    if (holder !== undefined) {
      throw new Error(
        `cannot resume session "${id}": its transcript is already open in another OMP process (pid ${holder}) — close it there first`,
      );
    }
    let mtimeMs = 0;
    try {
      mtimeMs = statSync(sessionFile).mtimeMs;
    } catch {
      // Unreadable now — the spawn below will surface the real error.
    }
    const hotMs = mtimeMs === 0 ? Number.POSITIVE_INFINITY : Date.now() - mtimeMs;
    if (hotMs < 2_000) {
      throw new Error(
        `cannot resume session "${id}": its transcript changed ${Math.round(hotMs)}ms ago — another OMP process may be writing it; retry in a moment`,
      );
    }

    // Re-attach to the OMP session by its persisted file (OMP owns the live
    // agent transcript and keeps generating it from here on).
    const rpc = await OmpSdkClient.spawn(["--approval-mode", approvalMode, "--resume", sessionFile], spawnCwd);

    // L3: TOCTOU closer — a TUI may have opened the file in the spawn window.
    const postHolder = foreignWriterPid(sessionFile);
    if (postHolder !== undefined) {
      rpc.close();
      throw new Error(`cannot resume session "${id}": a TUI process (pid ${postHolder}) opened it during spawn`);
    }

    try {
      // Promotion: reuse the live shadow projection (no re-enter, seq continuous).
      const shadowSession = supervisor.shadowSessionOf(id);
      if (shadowSession !== undefined) {
        trace(`resume id=${id} promoting shadow session`);
        const handle = await setupAndPublish(loopCtx, ownerCtx, id, options.agentOptions ?? {}, options.setup, shadowSession, rpc, options.parentAgent, "resume", { enterSession: false });
        return this.registerHeld(id, sessionFile, handle);
      }

      // Fresh attach: seed the Dash session log by replaying the OMP transcript
      // through the union persistence (scan → readMessages → replay).
      // Fresh attach: seed the Dash session log by replaying the OMP
      // transcript — through the union persistence when mounted (scan →
      // replay), else directly off the re-attached RPC.
      const seedEvents =
        persistence !== undefined
          ? await readStoredEvents(persistence, id, options.signal)
          : replayOmpMessages(await rpc.getMessages());
      const preparation = SessionPreparation.create(
        loopCtx.sessions.prepare(id, {
          seed: seedEvents,
          meta: {
            createdAt: record.createdAt,
            ...(spawnCwd === undefined ? {} : { cwd: spawnCwd }),
          },
        }),
      );
      // v2 header identity: mirror the prepared header onto the index row so
      // listed/loaded observations agree with the live one (the row's
      // insertion-instant created_at and the OMP-record epoch can drift).
      const resumeStore = getBridgeStore();
      if (resumeStore !== undefined) syncSessionHeader(resumeStore, String(id), preparation.session.header);
      trace(`resume id=${id} replayed transcript from OMP store`);

      const handle = await setupAndPublish(loopCtx, ownerCtx, id, options.agentOptions ?? {}, options.setup, preparation.session, rpc, options.parentAgent, "resume", { enterSession: true, preparation });
      return this.registerHeld(id, sessionFile, handle);
    } catch (error) {
      trace(`resume ${id} THREW: ${String(error)} | stack=${error instanceof Error ? error.stack?.slice(0, 400) : "n/a"}`);
      rpc.close();
      throw error;
    }
  }
  /**
   * Track a published RPC-backed agent and hand the session to the supervisor
   * as held. Arrow FIELD (not a `#` method): the provider is exposed through
   * a Cordis tracing proxy, and hard-private methods fail their brand check
   * on the proxy receiver (the same reason setupAndPublish is module-level).
   */
  private readonly registerHeld = (id: SessionId, file: string, handle: AgentHandle): AgentHandle => {
    const wrapped: AgentHandle = {
      agent: handle.agent,
      dispose: async () => {
        this.heldAgents.delete(String(id));
        await handle.dispose();
      },
    };
    this.heldAgents.set(String(id), wrapped);
    if (file !== "") supervisor.onHeld(String(id), file);
    return wrapped;
  };

  /** Avoidance hand-off (arrow field: proxy-safe). Abort the in-flight turn, bounded grace, teardown. */
  private readonly handleAvoidance = async (id: string): Promise<void> => {
    const handle = this.heldAgents.get(id);
    if (handle === undefined) return;
    const line = `[omp-supervisor] avoiding session ${id} — abort + bounded grace + teardown`;
    this.runtime.ctx.logger.warn(line);
    process.stderr.write(`${line}\n`);
    const agent = handle.agent;
    agent.cancel({ kind: "hook", reason: "tui-takeover" }, {});
    await Promise.race([
      agent.whenIdle(),
      new Promise<void>((resolve) => setTimeout(resolve, AVOIDANCE_GRACE_MS)),
    ]);
    await handle.dispose();
  };


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
  session: Session,
  rpc: OmpSdkClient,
  parentAgent: Agent | undefined,
  source: "startup" | "resume",
  opts: { enterSession: boolean; preparation?: SessionPreparation },
): Promise<AgentHandle> {
  let detachSession: (() => void) | undefined;
  let detachAgent: (() => void) | undefined;
  let agent: OmpAgent | undefined;
  // Late-bound teardown the agent triggers itself after its idle window
  // expires (see OmpAgent's idle exit) — defined only after publication.
  let idleExit: (() => void) | undefined;
  try {
    // Build the agent shim over the session and the live RPC client. For a
    // promoted shadow the session is already entered+announced; enterSession
    // is false and the projection is reused (seq-continuous promotion).
    agent = new OmpAgent(loopCtx, id, agentOptions, session, rpc, () => idleExit?.());

    // Surface node 0: stamp the live system prompt for a FRESH session (the
    // 0.1.5 contract forbids `header.system` on request/header). Fail-soft —
    // a replayed/resumed session already seeds its own `system/message`.
    if (!session.snapshotEvents().some((event) => event.type === "system/message")) {
      const liveSystemPrompt = await rpc.getSystemPrompt();
      if (liveSystemPrompt !== undefined && liveSystemPrompt !== "") {
        session.append("system/message", { turn: 0, step: 0, message: createSystemMessage(liveSystemPrompt, "omp-web") }, { surfaceOp: "append" });
      }
    }


    // Composition-only setup on the unpublished agent scope.
    const commit = await setup?.(agent.ctx, agent);

    // Publish: enter both session and agent, announce in order, then signal
    // session-start. The commit runs immediately before publication.
    commit?.commit();

    if (opts.enterSession) {
      detachSession = agent.ctx.sessions.enter(session);
      agent.ctx.sessions.announce(session);
    }
    detachAgent = loopCtx.agents.enter(agent, parentAgent);
    loopCtx.agents.announce(agent);
    emitAgentEvent(loopCtx, agent, "agent/session-start", { source });

    let disposed = false;
    let unfollowOwner: (() => void) | undefined;
    const dispose = async (): Promise<void> => {
      if (disposed) return;
      disposed = true;
      trace(`dispose() called for agent ${id} (source=${source}) stack=${new Error().stack?.split("\n").slice(1, 4).join(" <- ")}`);
      unfollowOwner?.();
      await agent?.dispose();
      detachAgent?.();
      detachSession?.();
      supervisor.onHeldDisposed(String(id));
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
    trace(`setupAndPublish ${id} FAILED: ${String(error)}`);
    detachAgent?.();
    detachSession?.();
    void agent?.dispose().catch(() => {});
    rpc.close();
    throw error;
  } finally {
    // Release the preparation's per-id reservation on every path (mirrors
    // the reference loop's unconditional dispose): the session it seeded is
    // already published above, so a same-process re-resume of this id can
    // prepare again instead of colliding with a leaked reservation. Promotion
    // has no preparation (the shadow's projection persists across the call).
    opts.preparation?.[Symbol.dispose]();
  }
}

export default OmpProvider;
