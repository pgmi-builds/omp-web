/**
 * OmpAgent — the Dash `Agent` shim over one live `omp --mode rpc` process.
 *
 * Bridges OMP's RPC event stream into the Dash `SessionEventMap`:
 *
 *   OMP RPC                         →  Dash session event
 *   ─────────────────────────────────────────────────────────────
 *   (send/followup delivers)        →  turn/start + user/message
 *   turn_start                      →  step/start
 *   message_update(text_delta)      →  assistant/chunk
 *   message_end(assistant)          →  assistant/message (+ usage, reasoning)
 *   message_end(toolResult)         →  tool/result (deduped vs tool_execution_end)
 *   tool_execution_start            →  tool/call
 *   tool_execution_end              →  tool/result
 *   turn_end                        →  step/end
 *   agent_end                       →  turn/end + status idle
 *
 * One Dash turn (user prompt → final answer) spans multiple OMP turns (one
 * assistant response + its tool executions each), so Dash turn/step boundaries
 * are synthesized around the OMP stream.
 */
import type { Context } from "@deepseek-ai/cordis";
import type {
  Agent,
  AgentOptions,
  AgentStatus,
  CancelOptions,
  InboxTarget,
} from "@deepseek-ai/dsh-agent";
import { Inbox, agentEvents, type AgentEventDispatch } from "@deepseek-ai/dsh-agent";
import type {
  AgentCancelCause,
  Session,
  SessionId,
  TurnEndReason,
  UserMessage,
} from "@deepseek-ai/dsh-session";
import type { AssistantMessage, ContentBlock, StreamChunk, TokenUsage } from "@deepseek-ai/dsh-llm";
import { CallId, QUOTA_EXCEEDED_CODE, createAssistantMessage, createToolResultMessage, createUserMessage } from "@deepseek-ai/dsh-llm";
import { createScope, type Scope } from "@deepseek-ai/dsh-scope";
import type { ApprovalOutcome, ApprovalService } from "@deepseek-ai/dsh-user-approval";
import type { OmpAssistantMessageEvent, OmpContentBlock, OmpMessage, OmpRpcClient, RpcEvent } from "./rpc.js";
// Type-only: pulls dsh-commands' `Context.commands` augmentation into this
// compilation (the runtime service is mounted by the base bundle).
import type {} from "@deepseek-ai/dsh-commands";
import { supervisor } from "./supervisor.js";

/** Diagnostic trace (set OMP_TRACE=1 on the dsh process to enable). */
const TRACE = process.env.OMP_TRACE === "1";
const trace = (...parts: unknown[]): void => {
  if (TRACE) process.stderr.write(`[omp-agent ${Date.now() % 1_000_000}] ${parts.join(" ")}\n`);
};

export function convertContent(blocks: OmpContentBlock[] | undefined): ContentBlock[] {
  if (blocks === undefined) return [];
  const result: ContentBlock[] = [];
  for (const block of blocks) {
    switch (block.type) {
      case "text":
        if (typeof block.text === "string") result.push({ type: "text", text: block.text });
        break;
      case "thinking":
        if (typeof block.thinking === "string") result.push({ type: "reasoning", text: block.thinking });
        break;
      case "toolCall": {
        const id = typeof block.id === "string" ? block.id : "";
        const name = typeof block.name === "string" ? block.name : "";
        const args = typeof block.arguments === "string" ? block.arguments : JSON.stringify(block.arguments ?? {});
        result.push({ type: "tool-call", id: CallId(id), name, arguments: args });
        break;
      }
      default:
        // images / unknown blocks are not bridged in Phase 2.
        break;
    }
  }
  return result;
}

/**
 * Classify OMP's `stopReason: "error"` assistant message into a Dash `failure`
 * (`{ message, code }`). This is the same taxonomy the harness adapters use for
 * `turn/end` reasons — `AUTH`, `RATE_LIMIT`, `QUOTA`, `SERVER` — so the Web UI
 * renders it through its own error path (the red "API key is invalid" alert,
 * turn-positioned failure feedback) instead of an empty assistant bubble.
 * Quota/usage wording is checked before the generic 403→AUTH because OMP's
 * providers (e.g. kimi) report an exhausted billing quota as HTTP 403.
 */
export function ompFailure(message: OmpMessage): { message: string; code: string } | undefined {
  if (message.stopReason !== "error") return undefined;
  const status = typeof message.errorStatus === "number" ? message.errorStatus : undefined;
  const text =
    typeof message.errorMessage === "string" && message.errorMessage.trim() !== ""
      ? message.errorMessage.trim()
      : undefined;
  const detail = text ?? "";
  let code: string;
  if (/\b(?:usage|rate)\s*limit\b/i.test(detail) || /\bquota\b/i.test(detail) || /\bbilling\b/i.test(detail) || /\binsufficient\b/i.test(detail)) {
    code = QUOTA_EXCEEDED_CODE;
  } else if (status === 401 || status === 403) {
    code = "AUTH";
  } else if (status === 429) {
    code = "RATE_LIMIT";
  } else if (status !== undefined && status >= 500) {
    code = "SERVER";
  } else {
    code = "UNKNOWN";
  }
  return { message: text ?? (status !== undefined ? `HTTP ${status}` : "model request failed"), code };
}

/** Map OMP's usage accounting into Dash `TokenUsage` (disjoint field names). */
export function convertUsage(usage: unknown): TokenUsage | undefined {
  if (usage === null || typeof usage !== "object") return undefined;
  const u = usage as Record<string, unknown>;
  const inputTokens = typeof u.input === "number" ? u.input : 0;
  const outputTokens = typeof u.output === "number" ? u.output : 0;
  if (inputTokens === 0 && outputTokens === 0) return undefined;
  const result: TokenUsage = { inputTokens, outputTokens };
  if (typeof u.cacheRead === "number") result.cacheReadTokens = u.cacheRead;
  if (typeof u.cacheWrite === "number") result.cacheWriteTokens = u.cacheWrite;
  if (typeof u.reasoningTokens === "number") result.reasoningTokens = u.reasoningTokens;
  return result;
}

/** Join the visible text blocks of a Dash user message into the OMP prompt string. */
function userMessageText(message: UserMessage): string {
  const parts: string[] = [];
  for (const block of message.content) {
    if (block.type === "text") parts.push(block.text);
  }
  return parts.join("\n");
}

/**
 * Dash-host plugin narration from the approval service: the policy-change
 * notice `agent.inject` carries when `/permission` switches a live session's
 * approval policy. OMP has no runtime approval control (its `--approval-mode`
 * is pinned at launch, with no RPC to change it mid-session), so forwarding
 * the text would steer it into an in-flight turn (interrupting tool work) and
 * echo it into history as a fake user prompt. Detect and drop it.
 */
function isApprovalNarration(message: UserMessage): boolean {
  const source = message.source;
  return source.kind === "plugin" && source.plugin === "user-approval";
}

/**
 * Reconstruct a Dash user message from an OMP `message_start(role=user)`
 * payload. Used only as a defensive fallback when a queued delivery's retained
 * message is missing (OMP echoes text, so the visible content is preserved).
 */
function userMessageFromOmp(message: OmpMessage): UserMessage {
  return createUserMessage({
    content: convertContent(message.content).filter((block) => block.type === "text"),
    source: { kind: "user" },
  });
}

/** Extract every tool call an OMP assistant message names, in order, for approval correlation. */
function toolCalls(blocks: OmpContentBlock[] | undefined): { callId: string; name: string }[] {
  if (blocks === undefined) return [];
  const result: { callId: string; name: string }[] = [];
  for (const block of blocks) {
    if (block.type === "toolCall" && typeof block.id === "string") {
      result.push({ callId: block.id, name: typeof block.name === "string" ? block.name : "" });
    }
  }
  return result;
}

/** Parse the tool name out of an OMP approval-card title (`Allow tool: <name>…`). */
function approvalToolName(title: string): string {
  const match = /Allow tool:\s*(\S+)/.exec(title);
  return match?.[1] ?? "tool";
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Approval answer timeout: fail closed (Deny) after this long so a headless or
 * server run can't hang forever waiting on a card nobody answers. `0` disables
 * the timeout. Default: 5 minutes.
 */
const OMP_IDLE_EXIT_MS = parseIdleExit(process.env.OMP_IDLE_EXIT_MS);

/**
 * How long an agent may sit idle before its omp rpc child is torn down. The
 * Dash host keeps resumed agents registered forever (nothing else disposes
 * them), and every idle agent pins a full `omp --mode rpc` process. Tearing
 * the agent down at idle costs nothing observable — the next prompt cold-
 * resumes the session from OMP's transcript through the replay persistence.
 * `0` disables the exit.
 */
function parseIdleExit(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return 600_000;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : 600_000;
}

const OMP_APPROVAL_TIMEOUT_MS = parseApprovalTimeout(process.env.OMP_APPROVAL_TIMEOUT_MS);

function parseApprovalTimeout(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return 300_000;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : 300_000;
}

/**
 * Race an approval request against the configured timeout. On timeout the
 * signal aborts (withdrawing the question) and we fail closed as `"cancelled"`.
 */
async function raceApproval(
  request: Promise<ApprovalOutcome>,
  controller: AbortController,
  timeoutMs: number,
): Promise<ApprovalOutcome> {
  if (timeoutMs <= 0) return request;
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      request,
      new Promise<ApprovalOutcome>((resolve) => {
        timer = setTimeout(() => {
          controller.abort();
          resolve("cancelled");
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The slice of `ctx.agentDefaultModel` the model-sync path reads. Typed
 * locally so the provider needs no dependency on the dsh-agent-default-model
 * package; the apiproxy writes the selection through `saveSelection` on
 * `session.selectModel`.
 */
interface AgentDefaultModelSlice {
  currentSelection(): { provider: string; model: string };
}

/** The slice of `ctx.systemPrompt` the selection snapshot needs: run the assemble waterfall. */
interface SystemPromptSlice {
  assemble(context?: { agent?: unknown; scope?: unknown; signal?: AbortSignal }): Promise<unknown>;
}

export class OmpAgent implements Agent {
  readonly id: SessionId;
  readonly options: AgentOptions;
  readonly session: Session;
  readonly inbox: Inbox;
  readonly ctx: Context;
  readonly #rpc: OmpRpcClient;
  readonly #loopCtx: Context;
  readonly #scope: Scope;
  readonly #dispatch: AgentEventDispatch;

  #streaming = false;
  #activityDone: Promise<void> = Promise.resolve();
  #resolveActivityDone: () => void = () => {};
  #dashTurn = 0;
  #step = 0;
  #lastTurn = 0;
  #turnOpen = false;
  #cancelCause: AgentCancelCause | null = null;
  /** Terminal model failure of the open turn (`message_end` stopReason "error"); consumed by `agent_end`. */
  #pendingFailure: { message: string; code: string } | null = null;
  #chunkSeqs: number[] = [];

  /** The current turn's user/message was appended locally and OMP's echo is still awaited. */
  #localUserPending = false;
  /** A `turn_start` arrived; `step/start` is deferred until the step's owning turn is known. */
  #stepStartPending = false;
  /**
   * Deliveries forwarded through OMP's own queue, in submission order. OMP
   * echoes each as `message_start(role=user)`; the bridge maps it by transport:
   * a `followUp` echo closes the current Dash turn and opens a fresh one
   * (OMP queues it and auto-generates the next turn — connection layer
   * hardcodes `resumeIfIdle: true`), a `steer` echo appends a `user/message`
   * step to the current turn. `sent` marks entries already dispatched to OMP
   * (a parked injection flushes at agent_start).
   */
  #remoteQueue: { message: UserMessage; sent: boolean; transport: "followUp" | "steer" }[] = [];
  #bridgedToolResults = new Set<string>();
  #pendingToolCalls: { callId: string; name: string }[] = [];
  #approvalAborts = new Set<AbortController>();
  /** The last selection already synced to OMP via `set_model`, as `provider/model`. */
  #lastSyncedModel: string | null = null;
  /** Fires when the agent has been idle past OMP_IDLE_EXIT_MS (tears down the rpc child). */
  readonly #onIdleExit: (() => void) | undefined;
  #idleExitTimer: NodeJS.Timeout | undefined = undefined;
  #disposed = false;

  constructor(loopCtx: Context, id: SessionId, options: AgentOptions, session: Session, rpc: OmpRpcClient, onIdleExit?: () => void) {
    this.#loopCtx = loopCtx;
    this.id = id;
    this.options = options;
    this.session = session;
    this.#rpc = rpc;
    this.#onIdleExit = onIdleExit;
    this.#dispatch = agentEvents(loopCtx, this);
    this.inbox = new Inbox(session, {
      inserted: (message) => this.#dispatch.emit("agent/inbox/inserted", { message }),
      discarded: (message) => this.#dispatch.emit("agent/inbox/discarded", { message }),
      claimed: (message, turn) => this.#dispatch.emit("agent/inbox/claimed", { message, turn }),
    });
    this.#scope = createScope(loopCtx, this);
    this.ctx = this.#scope.ctx.extend({ agent: this });
    this.#lastTurn = session.events.findLast((event) => event.type === "turn/start")?.data.turn ?? 0;
    rpc.on((event) => this.#handleEvent(event));
    rpc.onFailure((error) => this.#fail(error));
    // OMP is single-mode: stamp the live session's preset so the chat-header
    // badge resolves it from events even for a scan-native session resumed
    // under a header that predates the roster. Idempotent — skip when present.
    if (!session.events.some((event) => event.type === "agent-preset/selected" && event.data?.agentPreset === "omp")) {
      session.append("agent-preset/selected", { agentPreset: "omp" });
    }
    // `/permission` cannot work here: OMP pins `--approval-mode` at launch and
    // no RPC changes it mid-session. Registering the SAME name on this agent's
    // own scope (a command-injected child of `agent.ctx`) SHADOWS the global
    // permission command for this agent only — the switch then fails cleanly
    // instead of appending approval/policy events OMP cannot honor. (The
    // `inject` narration drop below stays as the backstop.)
    this.ctx.inject(["commands"], (cmdCtx) =>
      cmdCtx.commands.register({
        name: "permission",
        description: "Unavailable for OMP sessions (approval policy is fixed at OMP launch)",
        input: { hint: "<preset>" },
        handler: () => ({
          kind: "error" as const,
          text: "Approval policy is fixed at OMP launch; runtime switching is not supported for OMP sessions.",
        }),
      }),
    );
  }

  get status(): AgentStatus {
    return this.#streaming ? "running" : "idle";
  }

  send(message: UserMessage, target: InboxTarget, wakeup: boolean): void {
    this.#deliver(message, target, wakeup);
  }

  followup(message: UserMessage): void {
    // The Web UI's `session.prompt` (mode "queue") routes through followup.
    // Idle → `prompt` (opens the Dash turn locally, before OMP's ~2s cold
    // start); busy → `follow_up` (OMP's own queue: delivered as the next
    // turn's user message and auto-generated). Mirrors dsh-agent-loop's
    // `followup = send(input, "next-turn", true)`.
    this.#deliver(message, "next-turn", true);
  }

  steer(message: UserMessage): void {
    // Mirrors dsh-agent-loop's `steer = send(input, "next-step", true)`: an
    // idle driver starts a turn; a running driver consumes it at the next step.
    this.#deliver(message, "next-step", true);
  }

  inject(message: UserMessage): void {
    // Dash-host approval-policy narrations have no OMP runtime equivalent
    // (OMP pins `--approval-mode` at launch; no RPC changes it mid-session).
    // Forwarding the text would steer it into an in-flight turn — interrupting
    // tool work — and echo it into history as a fake user prompt. Drop it; the
    // accompanying `approval/policy` session event stays recorded so the UI's
    // permission state remains truthful.
    if (isApprovalNarration(message)) {
      trace("inject: dropped approval-policy narration (OMP lacks runtime approval control)");
      return;
    }
    // Mirrors dsh-agent-loop's `inject = send(input, "next-step", false)`:
    // queued without waking; idle drivers leave it pending until a later
    // follow-up/steer wakes them (flushed at the next agent_start).
    this.#deliver(message, "next-step", false);
  }

  cancel(cause: AgentCancelCause, _options?: CancelOptions): void {
    // No active run → no-op: arming `#cancelCause` here would misreport a later,
    // unrelated completed turn as aborted. First cause wins: later cancels must
    // not overwrite an earlier cause (dash contract).
    if (!this.#streaming) return;
    if (this.#cancelCause === null) this.#cancelCause = cause;
    void this.#rpc.abort().catch(() => {});
  }

  async whenIdle(): Promise<void> {
    // Event-driven: wait for the current activity to settle (agent_end), then
    // confirm OMP reports quiescence via get_state (the mapping's poll).
    let activity: Promise<void>;
    do {
      activity = this.#activityDone;
      await activity;
    } while (activity !== this.#activityDone);
    for (;;) {
      const state = await this.#rpc.getState().catch(() => null);
      if (state === null || !state.isStreaming) return;
      await delay(50);
    }
  }

  runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    // OMP has no maintenance concept; run the task directly.
    return task(new AbortController().signal);
  }

  /** Stop OMP and unwind the scoped world. Idempotent. */
  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    clearTimeout(this.#idleExitTimer);
    this.#idleExitTimer = undefined;
    for (const controller of this.#approvalAborts) controller.abort();
    this.#approvalAborts.clear();
    this.#rpc.close();
    await this.#scope.dispose();
  }

  // ── internals ────────────────────────────────────────────────────────────

  /**
   * Route one message by the reference loop's (target, wakeup) semantics:
   * an idle waking delivery starts a fresh local turn (`prompt`); a follow-up
   * sent while a turn is open is forwarded to OMP's own queue (`follow_up`:
   * OMP delivers it as the next turn's user message and auto-generates that
   * turn); steering/injection goes through `steer` (consumed at the next
   * step, or parked until agent_start when not yet streaming).
   *
   * Busy is the LOCAL turn state (`#turnOpen`), not OMP's `#streaming` flag:
   * OMP needs a moment (cold child start) to emit `agent_start` after a
   * prompt, and in that gap a bare `prompt` would be rejected by OMP while
   * `follow_up` is state-safe (it queues and resumes from either state).
   */
  #deliver(message: UserMessage, target: InboxTarget, wakeup: boolean): void {
    if (this.#disposed) return;
    const busy = this.#turnOpen || this.#streaming;
    trace(`#deliver target=${target} wakeup=${wakeup} busy=${busy} (turnOpen=${this.#turnOpen} streaming=${this.#streaming})`);
    if (busy && target === "next-turn") {
      this.#queueRemote(message, "followUp");
      return;
    }
    if (busy || !wakeup) {
      this.#queueRemote(message, "steer");
      return;
    }
    this.#deliverPrompt(message);
  }
  #deliverPrompt(message: UserMessage): void {
    if (this.#disposed) return;
    trace(`#deliverPrompt turn=${this.#dashTurn + 1} text="${userMessageText(message).slice(0, 40)}"`);
    this.#openTurn(message);
    const text = userMessageText(message);
    clearTimeout(this.#idleExitTimer);
    this.#idleExitTimer = undefined;
    supervisor.reportUserText(String(this.id), text);
    this.#beginActivity();
    void this.#syncModelSelection().finally(() => {
      void this.#rpc.prompt(text).catch((error) => this.#fail(error));
    });
  }

  /**
   * Queue a message for OMP-side delivery. `followUp` dispatches immediately
   * (state-safe whether or not OMP is streaming); `steer` dispatches now when
   * already streaming, otherwise parks until agent_start.
   */
  #queueRemote(message: UserMessage, transport: "followUp" | "steer"): void {
    if (this.#disposed) return;
    clearTimeout(this.#idleExitTimer);
    this.#idleExitTimer = undefined;
    supervisor.reportUserText(String(this.id), userMessageText(message));
    this.#remoteQueue.push({ message, sent: false, transport });
    if (this.#streaming || transport === "followUp") this.#flushRemote();
  }

  #flushRemote(): void {
    void this.#syncModelSelection().finally(() => {
      for (const entry of this.#remoteQueue) {
        if (entry.sent) continue;
        entry.sent = true;
        const text = userMessageText(entry.message);
        const sent = entry.transport === "followUp" ? this.#rpc.followUp(text) : this.#rpc.steer(text);
        trace(`-> ${entry.transport} "${text.slice(0, 40)}"`);
        void sent.catch((error) => this.#fail(error));
      }
    });
  }

  /**
   * The selection a turn should run under, resolved exactly as the native
   * loop resolves it (`buildRequest`): the base is the session's logged
   * `request/header` (the replay synthesizes it from OMP's transcript, so a
   * resumed session keeps ITS last model) falling back to the global default;
   * the `system-prompt/assemble` → `agent/request` waterfall pair then applies
   * the apiproxy's installed selection, so a switch made in the Web UI this
   * process still wins. OMP itself already restores the transcript's model on
   `--resume`, which is why {@link #syncModelSelection} only pushes when the
   * resolved target differs from OMP's live state.
   */
  async #effectiveModelSelection(): Promise<{ provider: string; model: string }> {
    const base = this.#baseModelSelection();
    const systemPrompt = this.ctx.get("systemPrompt") as SystemPromptSlice | undefined;
    if (systemPrompt !== undefined) {
      try {
        await systemPrompt.assemble({ agent: this, scope: this });
      } catch (error) {
        trace(`model selection assemble failed: ${String(error)}`);
      }
    }
    try {
      const resolved = await this.#dispatch.waterfall(
        "agent/request",
        { turn: this.#dashTurn, step: this.#step, signal: new AbortController().signal },
        () => Promise.resolve(base),
      );
      if (resolved.provider !== "" && resolved.model !== "") {
        return { provider: resolved.provider, model: resolved.model };
      }
    } catch (error) {
      trace(`model selection waterfall failed: ${String(error)}`);
    }
    return base;
  }

  /** Tier-2/3 base: the session's logged header config, else the global default, else agent options. */
  #baseModelSelection(): { provider: string; model: string } {
    const persisted = this.session.requestHeader()?.config;
    if (persisted !== undefined && persisted.provider !== "" && persisted.model !== "") {
      return { provider: persisted.provider, model: persisted.model };
    }
    const service = this.ctx.get("agentDefaultModel") as AgentDefaultModelSlice | undefined;
    const selection = service?.currentSelection();
    if (selection !== undefined && selection.provider !== "" && selection.model !== "") return selection;
    return { provider: this.options.provider ?? "", model: this.options.model ?? "" };
  }

  /**
   * Sync the effective model selection into OMP before a turn is dispatched.
   * `set_model` fires only when the resolved target differs from OMP's live
   * model, so a plain resume (OMP already restored the transcript's model, and
   * the replayed header names the same one) performs no round-trip at all.
   */
  async #syncModelSelection(): Promise<void> {
    const target = await this.#effectiveModelSelection();
    const key = `${target.provider}/${target.model}`;
    if (key === this.#lastSyncedModel) return;
    const state = await this.#rpc.getState().catch(() => null);
    const ompModel = state?.model;
    if (ompModel?.provider === target.provider && ompModel?.id === target.model) {
      this.#lastSyncedModel = key;
      return;
    }
    await this.#rpc.setModel(target.provider, target.model).catch((error) => {
      trace(`set_model ${key} failed: ${String(error)}`);
    });
    this.#lastSyncedModel = key;
  }

  #openTurn(message: UserMessage, localUser = true): void {
    trace(`#openTurn turnOpen=${this.#turnOpen} -> turn=${this.#dashTurn + 1} localUser=${localUser}`);
    if (this.#turnOpen) return;
    this.#dashTurn = ++this.#lastTurn;
    this.#step = 0;
    this.#turnOpen = true;
    this.#localUserPending = localUser;
    this.session.append("turn/start", { turn: this.#dashTurn });
    this.session.append("user/message", message, { surfaceOp: "append" });
  }

  #closeTurn(reason: TurnEndReason): void {
    if (!this.#turnOpen) return;
    this.#turnOpen = false;
    this.#localUserPending = false;
    this.session.append("turn/end", { turn: this.#dashTurn, reason });
  }

  /**
   * Append the deferred `step/start` now that the step's first message has
   * revealed which Dash turn owns it (a queued follow-up opens a fresh turn).
   */
  #commitStepStart(): void {
    if (!this.#stepStartPending) return;
    this.#stepStartPending = false;
    if (!this.#turnOpen) return;
    this.#step += 1;
    this.session.append("step/start", { turn: this.#dashTurn, step: this.#step });
  }

  /**
   * Bridge an OMP `message_start(role=user)` that was NOT appended locally.
   * A `followUp` echo closes the current Dash turn and opens a fresh one with
   * the retained message (OMP queued it and is now generating its turn); a
   * steering/injection echo adds a `user/message` step to the current turn.
   * Falls back to OMP's own content if no retained message matches.
   */
  #bridgeRemoteUser(ompMessage: OmpMessage): void {
    const entry = this.#remoteQueue.shift();
    if (entry === undefined) {
      this.#closeTurn({ kind: "completed" });
      this.#openTurn(userMessageFromOmp(ompMessage), false);
      return;
    }
    if (entry.transport === "followUp") {
      this.#closeTurn({ kind: "completed" });
      this.#openTurn(entry.message, false);
      return;
    }
    this.session.append("user/message", entry.message, { surfaceOp: "append" });
  }

  #beginActivity(): void {
    // Settle any prior in-flight activity first: `send()` can inject a prompt
    // mid-stream (streamingBehavior followUp/steer), superseding the current
    // activity promise. Without settling the old one, whenIdle()'s do-while
    // would await an orphaned promise that never resolves.
    this.#resolveActivityDone();
    this.#activityDone = new Promise<void>((resolve) => {
      this.#resolveActivityDone = resolve;
    });
  }

  #endActivity(): void {
    this.#resolveActivityDone();
  }

  #markRunning(): void {
    clearTimeout(this.#idleExitTimer);
    this.#idleExitTimer = undefined;
    if (this.#streaming) return;
    this.#streaming = true;
    this.#dispatch.emit("agent/status", { status: "running" });
  }

  #markIdle(): void {
    if (!this.#streaming) return;
    this.#streaming = false;
    this.#dispatch.emit("agent/status", { status: "idle" });
    this.#armIdleExit();
  }

  /**
   * Schedule the idle exit. Skipped while deliveries are still queued (an
   * unanswered parked injection means work is pending, not idle) or when the
   * exit is disabled. Any later activity restarts or cancels the timer.
   */
  #armIdleExit(): void {
    if (this.#disposed || this.#onIdleExit === undefined || OMP_IDLE_EXIT_MS === 0) return;
    if (this.#remoteQueue.some((entry) => !entry.sent)) return;
    clearTimeout(this.#idleExitTimer);
    this.#idleExitTimer = setTimeout(() => {
      this.#idleExitTimer = undefined;
      void this.#revalidateIdleExit();
    }, OMP_IDLE_EXIT_MS);
    this.#idleExitTimer.unref?.();
  }

  /**
   * Five-fold quiescence re-validation at fire time. The idle timer is only a
   * hint: before teardown, re-confirm no live work via local signals and OMP's
   * own self-attestation (get_state streaming/compacting/queued, get_subagents
   * liveness). Any busy signal re-arms instead of killing; a query failure
   * fail-softs to the local signals rather than forcing a teardown.
   */
  async #revalidateIdleExit(): Promise<void> {
    if (this.#disposed || this.#streaming) return this.#armIdleExit();
    if (this.#remoteQueue.some((entry) => !entry.sent)) return this.#armIdleExit();
    if (this.#approvalAborts.size > 0) return this.#armIdleExit();
    try {
      const state = await this.#rpc.getState();
      if (this.#streaming) return this.#armIdleExit();
      if (state.isStreaming) return this.#armIdleExit();
      if (state.isCompacting === true) return this.#armIdleExit();
      if (typeof state.queuedMessageCount === "number" && state.queuedMessageCount > 0) return this.#armIdleExit();
    } catch {
      // Self-attestation unavailable: local signals remain authoritative.
    }
    try {
      const subagents = await this.#rpc.getSubagents();
      if (this.#streaming) return this.#armIdleExit();
      if (subagents.length > 0) return this.#armIdleExit();
    } catch {
      // getSubagents fail-softs already; belt-and-suspenders.
    }
    if (this.#streaming) return this.#armIdleExit();
    trace(`idle exit after ${OMP_IDLE_EXIT_MS}ms — disposing agent ${this.id}`);
    this.#onIdleExit?.();
  }

  #fail(error: unknown): void {
    if (this.#disposed) return;
    trace(`#fail ${String(error).slice(0, 200)}`);
    this.#closeTurn({ kind: "error", error: { message: String(error), code: "UNKNOWN" } });
    this.#markIdle();
    this.#endActivity();
  }

  #handleEvent(event: RpcEvent): void {
    switch (event.type) {
      case "agent_start":
        trace("event agent_start");
        this.#markRunning();
        this.#flushRemote();
        break;
      case "turn_start":
        // Defer `step/start`: the step's owning turn is only known once its
        // first message arrives (a queued follow-up opens a fresh turn).
        trace("event turn_start");
        this.#stepStartPending = true;
        this.#pendingFailure = null;
        break;

      case "message_start": {
        const message = event.message as OmpMessage | undefined;
        if (message?.role === "user") {
          if (this.#localUserPending) {
            // OMP is echoing the user message #openTurn already appended.
            this.#localUserPending = false;
          } else {
            // A queued follow-up / steering message delivered by OMP.
            this.#bridgeRemoteUser(message);
          }
        } else if (message?.role === "assistant") {
          // Reset per-message streaming accumulators.
          this.#chunkSeqs = [];
        }
        // role === "toolResult" is bridged in message_end (deduped vs tool_execution_end).
        this.#commitStepStart();
        break;
      }

      case "message_update": {
        const delta = event.assistantMessageEvent as OmpAssistantMessageEvent | undefined;
        if (delta !== undefined) this.#handleUpdate(delta);
        break;
      }

      case "message_end": {
        const message = event.message as OmpMessage | undefined;
        if (message === undefined) break;
        const role = message.role as string;
        if (role === "assistant") {
          const failure = ompFailure(message);
          if (failure !== undefined) {
            this.#pendingFailure = failure;
            this.#chunkSeqs = [];
          } else {
            this.#appendAssistantMessage(message);
          }
        } else if (role === "toolResult") {
          this.#appendToolResultMessage(message);
        } else if (role !== "user") {
          process.stderr.write(`omp rpc: unhandled message_end role "${role}"\n`);
        }
        break;
      }

      case "tool_execution_start": {
        const callId = String(event.toolCallId ?? "");
        const name = String(event.toolName ?? "");
        this.session.append("tool/call", {
          turn: this.#dashTurn,
          step: this.#step,
          callId: CallId(callId),
          name,
          arguments: JSON.stringify(event.args ?? {}),
        });
        // The assistant's pending tool call is now materialized as a running call.
        this.#pendingToolCalls = this.#pendingToolCalls.filter((pending) => pending.callId !== callId);
        break;
      }

      case "extension_ui_request":
        void this.#handleExtensionUiRequest(event);
        break;

      case "tool_execution_end":
        this.#appendToolResult(event);
        break;

      case "turn_end":
        trace("event turn_end");
        if (this.#turnOpen) {
          this.session.append("step/end", { turn: this.#dashTurn, step: this.#step });
        }
        break;

      case "agent_end": {
        trace(`event agent_end cancelCause=${String(this.#cancelCause)}`);
        const pendingFailure = this.#pendingFailure;
        this.#pendingFailure = null;
        this.#closeTurn(
          this.#cancelCause !== null
            ? { kind: "aborted", reason: this.#cancelCause }
            : pendingFailure !== null
              ? { kind: "error", error: pendingFailure }
              : { kind: "completed" },
        );
        this.#cancelCause = null;
        this.#markIdle();
        this.#endActivity();
        // Live metadata the Dash surface has no projection seam for yet:
        // surface OMP's own accounting (tokens, contextUsage, cost) in the
        // diagnostic trace so it is observable per completed turn.
        void this.#rpc
          .getSessionStats()
          .then((stats) => {
            trace(`sessionStats tokens=${JSON.stringify(stats.tokens ?? {})} contextUsage=${String(stats.contextUsage)} cost=${JSON.stringify(stats.cost ?? {})}`);
          })
          .catch(() => {});

        break;
      }
    }
  }

  #handleUpdate(delta: OmpAssistantMessageEvent): void {
    switch (delta.type) {
      case "text_delta":
        if (typeof delta.delta === "string" && delta.delta !== "") {
          const chunk: StreamChunk = { type: "text-delta", index: delta.contentIndex ?? 0, text: delta.delta };
          const seq = this.session.append("assistant/chunk", {
            turn: this.#dashTurn,
            step: this.#step,
            chunk,
          }).seq;
          this.#chunkSeqs.push(seq);
        }
        break;
      default:
        // text_start/text_end/thinking_*/toolcall_* are folded into the final message.
        break;
    }
  }

  /**
   * Bridge an OMP `extension_ui_request`. Approval cards (`select` with an
   * "Approve" option) round-trip through the Dash approval seam
   * (`ctx.get("approval").request()`), which the Web UI renders as an
   * ApprovalPanel. Every OTHER blocking dialog (confirm/input/editor, or a
   * select lacking "Approve") gets the universal cancellation so OMP never
   * blocks forever.
   */
  async #handleExtensionUiRequest(event: RpcEvent): Promise<void> {
    const id = String(event.id ?? "");
    if (id === "") return;

    const method = String(event.method ?? "");
    const options = Array.isArray(event.options) ? (event.options as string[]) : [];
    if (method !== "select" || !options.includes("Approve")) {
      // Not an approval card: cancel the dialog so OMP can keep going.
      this.#rpc.sendRaw({ type: "extension_ui_response", id, cancelled: true });
      return;
    }

    const title = typeof event.title === "string" ? event.title : "";
    const pending = this.#matchPendingToolCall(title);
    const toolName = pending !== null && pending.name !== "" ? pending.name : approvalToolName(title);
    const callId = pending !== null ? CallId(pending.callId) : undefined;
    const reason = title !== "" ? title : undefined;

    // `ctx.approval` is provided by a sibling fiber in the real profile, so a
    // property read throws "cannot get property ... without inject"; `ctx.get`
    // resolves the store from any ctx instead.
    const approval = this.ctx.get("approval") as ApprovalService | undefined;
    if (approval === undefined) {
      // Fail closed: without an answerer the tool must not run.
      this.#rpc.sendRaw({ type: "extension_ui_response", id, value: "Deny" });
      return;
    }

    const controller = new AbortController();
    this.#approvalAborts.add(controller);
    try {
      const outcome = await raceApproval(
        approval.request({
          agent: this,
          toolName,
          ...(callId === undefined ? {} : { callId }),
          ...(reason === undefined ? {} : { reason }),
          signal: controller.signal,
        }),
        controller,
        OMP_APPROVAL_TIMEOUT_MS,
      );
      // Fail closed: only an explicit one-shot grant approves.
      this.#rpc.sendRaw({
        type: "extension_ui_response",
        id,
        value: outcome === "allowed-once" ? "Approve" : "Deny",
      });
    } catch {
      // A synchronous throw (no open turn / audit append failure) still denies
      // rather than hanging OMP.
      this.#rpc.sendRaw({ type: "extension_ui_response", id, value: "Deny" });
    } finally {
      this.#approvalAborts.delete(controller);
    }
  }

  /**
   * Match an approval card to its pending tool call, preferring the pending
   * call whose name equals the card title's tool name and falling back to the
   * first pending call. Consumes the match so a denied card (which never emits
   * `tool_execution_start`) can't be re-matched by a later card.
   */
  #matchPendingToolCall(title: string): { callId: string; name: string } | null {
    if (this.#pendingToolCalls.length === 0) return null;
    const titleName = approvalToolName(title);
    let index = this.#pendingToolCalls.findIndex((pending) => pending.name !== "" && pending.name === titleName);
    if (index === -1) index = 0;
    const [matched] = this.#pendingToolCalls.splice(index, 1);
    return matched ?? null;
  }

  #appendAssistantMessage(message: OmpMessage): void {
    this.#pendingToolCalls = toolCalls(message.content);
    const content = convertContent(message.content);
    const usage = convertUsage(message.usage);
    const assistant: AssistantMessage = createAssistantMessage({
      content,
      source: {
        provider: String(message.provider ?? this.options.provider ?? ""),
        model: String(message.model ?? this.options.model ?? ""),
      },
    });
    this.session.append("assistant/message", {
      turn: this.#dashTurn,
      step: this.#step,
      message: assistant,
      ...(usage === undefined ? {} : { usage }),
    }, {
      surfaceOp: "append",
      sourceEventSeqs: this.#chunkSeqs,
    });
    this.#chunkSeqs = [];
  }

  #appendToolResult(event: RpcEvent): void {
    const callId = String(event.toolCallId ?? "");
    this.#bridgedToolResults.add(callId);
    const result = event.result as { content?: OmpContentBlock[]; isError?: boolean } | undefined;
    const isError = Boolean(event.isError ?? result?.isError ?? false);
    const message = createToolResultMessage({
      callId: CallId(callId),
      content: convertContent(result?.content),
      isError,
    });
    this.session.append("tool/result", {
      turn: this.#dashTurn,
      step: this.#step,
      message,
      ...(isError ? { error: { name: "ToolExecutionError", code: "TOOL_ERROR" } } : {}),
    }, {
      surfaceOp: "append",
    });
  }

  #appendToolResultMessage(message: OmpMessage): void {
    const callId = String(message.toolCallId ?? "");
    // The normal path bridges via `tool_execution_end` first; skip the
    // `message_end(toolResult)` duplicate OMP always also emits.
    if (this.#bridgedToolResults.has(callId)) return;
    this.#bridgedToolResults.add(callId);
    const isError = Boolean(message.isError ?? false);
    const result = createToolResultMessage({
      callId: CallId(callId),
      content: convertContent(message.content),
      isError,
    });
    this.session.append("tool/result", {
      turn: this.#dashTurn,
      step: this.#step,
      message: result,
      ...(isError ? { error: { name: "ToolExecutionError", code: "TOOL_ERROR" } } : {}),
    }, {
      surfaceOp: "append",
    });
  }
}
