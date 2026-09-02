/**
 * Thin NDJSON client over `omp --mode rpc` stdio.
 *
 * Protocol (from `prime-agent` docs/rpc.md, measured in Phase 0):
 * - Commands are JSON objects written to stdin, one per LF-delimited line, with
 *   an optional `id` field for request/response correlation.
 * - Events stream from stdout as JSON lines. Only `response` records carry an
 *   `id`; events never do. The first record is `ready`.
 *
 * Framing is strict JSONL: split on `\n` only and strip a trailing `\r`. The
 * Node `readline` interface is deliberately NOT used (it splits on U+2028 and
 * U+2029, which are valid inside JSON strings).
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

/** A `response` record (command acknowledgement). */
export interface RpcResponse {
  id?: string;
  type: "response";
  command: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

/** Any event record streamed from OMP. */
export interface RpcEvent {
  type: string;
  [key: string]: unknown;
}

/** One content block inside an OMP `AgentMessage`. */
export interface OmpContentBlock {
  type: string;
  [key: string]: unknown;
}

/** An OMP `AgentMessage` (user | assistant | toolResult). */
export interface OmpMessage {
  role: "user" | "assistant" | "toolResult";
  content?: OmpContentBlock[];
  [key: string]: unknown;
}

/** The `assistantMessageEvent` delta carried by a `message_update` event. */
export interface OmpAssistantMessageEvent {
  type: string;
  contentIndex?: number;
  delta?: string;
  content?: string;
  partial?: unknown;
  toolCall?: unknown;
}

/** The `get_state` response payload. */
export interface OmpState {
  isStreaming: boolean;
  sessionId?: string;
  sessionFile?: string;
  /** The currently selected model (`get_state` returns the full model record). */
  model?: { id: string; provider: string; name?: string; [key: string]: unknown };
  [key: string]: unknown;
}

/** The `get_session_stats` response payload (live sessions only). */
export interface OmpSessionStats {
  tokens?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
  contextUsage?: number;
  cost?: unknown;
  [key: string]: unknown;
}


/**
 * An OMP `extension_ui_request` record. Approval cards surface as
 * `method: "select"` with `options: ["Approve", "Deny"]`; the client answers
 * with an `extension_ui_response` echoing the request `id` and a `value`.
 */
export interface RpcExtensionUiRequest {
  type: "extension_ui_request";
  id: string;
  method: string;
  title?: string;
  options?: string[];
  [key: string]: unknown;
}

/**
 * Readiness deadline: bound the `ready` handshake so a broken spawn fails
 * instead of hanging the caller forever. OMP can take a long time to emit
 * `ready` while it performs MCP server connection and model discovery — a
 * localhost model provider that drops (rather than rejects) the connection can
 * hang until its own timeout, and a cold `npx` MCP server can take tens of
 * seconds to spawn. The default is therefore generous; `0` disables the
 * deadline. Override with `OMP_READY_TIMEOUT_MS`.
 */
const READY_TIMEOUT_MS = parseTimeout(process.env.OMP_READY_TIMEOUT_MS, 120_000);

/**
 * Per-command response deadline: bound every blocking request so an
 * unresponsive OMP (e.g. a hung `get_messages` during resume) fails within a
 * fixed window instead of stalling the caller indefinitely. `0` disables the
 * deadline. Override with `OMP_COMMAND_TIMEOUT_MS`.
 */
const COMMAND_TIMEOUT_MS = parseTimeout(process.env.OMP_COMMAND_TIMEOUT_MS, 30_000);

/** Parse a non-negative millisecond timeout; empty/missing → `fallback`, invalid → `fallback`. */
function parseTimeout(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

/**
 * Grace period between SIGTERM and the SIGKILL escalation that guarantees a
 * stubborn `omp` (and its tool subprocesses) never survives teardown.
 */
const KILL_GRACE_MS = 2_000;

/** One in-flight command awaiting its `response` record. */
type PendingCommand = {
  resolve: (r: RpcResponse) => void;
  reject: (e: Error) => void;
  /** Cancel the command's response deadline timer. */
  clear: () => void;
};

export class OmpRpcClient {
  readonly #proc: ChildProcessWithoutNullStreams;
  readonly #listeners = new Set<(event: RpcEvent) => void>();
  readonly #failureListeners = new Set<(error: Error) => void>();
  readonly #pending = new Map<string, PendingCommand>();
  readonly #ready: Promise<void>;
  #readyResolve!: () => void;
  #readyReject!: (error: Error) => void;
  #nextId = 0;
  #buffer = "";
  #closed = false;
  #killed = false;
  #killTimer: NodeJS.Timeout | null = null;
  #failure: Error | null = null;

  /** Spawn `omp --mode rpc` and resolve once the `ready` handshake arrives. */
  static async spawn(args: string[] = [], cwd?: string): Promise<OmpRpcClient> {
    const client = new OmpRpcClient(args, cwd);
    await client.#ready;
    return client;
  }

  private constructor(args: string[], cwd?: string) {
    this.#proc = spawn("omp", ["--mode", "rpc", ...args], {
      stdio: ["pipe", "pipe", "pipe"],
      // Own process group so teardown can signal omp AND its tool subprocesses.
      detached: true,
      ...(cwd === undefined ? {} : { cwd }),
    });

    this.#ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#fail(new Error("omp --mode rpc: timed out waiting for the `ready` event"));
      }, READY_TIMEOUT_MS);
      this.#readyResolve = () => {
        clearTimeout(timer);
        resolve();
      };
      this.#readyReject = (error: Error) => {
        clearTimeout(timer);
        reject(error);
      };
    });

    this.#proc.stdout.setEncoding("utf8");
    this.#proc.stdout.on("data", (chunk: string) => this.#onData(chunk));
    this.#proc.stderr.setEncoding("utf8");
    this.#proc.stderr.on("data", (chunk: string) => {
      // OMP writes diagnostics to stderr; surface them for debugging.
      process.stderr.write(chunk);
    });
    this.#proc.on("error", (error) => this.#fail(error));
    this.#proc.on("exit", (code) => {
      if (this.#killTimer !== null) {
        clearTimeout(this.#killTimer);
        this.#killTimer = null;
      }
      if (!this.#closed) this.#fail(new Error(`omp --mode rpc exited unexpectedly (code ${code})`));
    });
  }

  /** Register an event listener; returns the unsubscriber. */
  on(listener: (event: RpcEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** Register a failure listener invoked when the child exits or errors. Returns the unsubscriber. */
  onFailure(listener: (error: Error) => void): () => void {
    this.#failureListeners.add(listener);
    return () => {
      this.#failureListeners.delete(listener);
    };
  }

  /**
   * Write one fire-and-forget command that must NOT carry a correlation id.
   * `extension_ui_response` keys its `id` to the originating UI request, so the
   * correlation-adding `send()` would clobber it.
   */
  sendRaw(command: Record<string, unknown>): void {
    if (this.#failure !== null || this.#closed) return;
    try {
      this.#proc.stdin.write(JSON.stringify(command) + "\n");
    } catch (error) {
      process.stderr.write(`omp rpc write error: ${String(error)}\n`);
    }
  }
  /**
   * Send one command and resolve with its `response`. Fire-and-forget callers
   * may ignore the promise. A per-command deadline (see COMMAND_TIMEOUT_MS)
   * rejects the request if OMP never answers, so blocking callers
   * (`getMessages`) can't stall indefinitely; pass `timeoutMs` to override,
   * or `0` to disable the deadline.
   */
  send(command: Record<string, unknown>, timeoutMs: number = COMMAND_TIMEOUT_MS): Promise<RpcResponse> {
    if (this.#failure !== null) return Promise.reject(this.#failure);
    if (this.#closed) return Promise.reject(new Error("omp rpc client is closed"));
    const id = `omp-${++this.#nextId}`;
    return new Promise<RpcResponse>((resolve, reject) => {
      const pending: PendingCommand = {
        resolve,
        reject,
        clear: () => {},
      };
      if (timeoutMs > 0) {
        const timer = setTimeout(() => {
          if (this.#pending.delete(id)) {
            reject(new Error(`omp rpc command timed out after ${timeoutMs}ms`));
          }
        }, timeoutMs);
        pending.clear = () => clearTimeout(timer);
      }
      this.#pending.set(id, pending);
      try {
        this.#proc.stdin.write(JSON.stringify({ ...command, id }) + "\n");
      } catch (error) {
        this.#pending.delete(id);
        pending.clear();
        reject(error);
      }
    });
  }

  /** Query `get_state`; returns the state payload. */
  async getState(): Promise<OmpState> {
    const response = await this.send({ type: "get_state" });
    if (!response.success) throw new Error(`omp get_state failed: ${String(response.error ?? "unknown error")}`);
    return (response.data ?? { isStreaming: false }) as OmpState;
  }

  /** Query `get_messages`; returns the full conversation. */
  async getMessages(): Promise<OmpMessage[]> {
    const response = await this.send({ type: "get_messages" });
    if (!response.success) throw new Error(`omp get_messages failed: ${String(response.error ?? "unknown error")}`);
    const data = response.data as { messages?: OmpMessage[] } | undefined;
    return data?.messages ?? [];
  }
  /** Query `get_session_stats`; live token/context/cost accounting (live sessions only). */
  async getSessionStats(): Promise<OmpSessionStats> {
    const response = await this.send({ type: "get_session_stats" });
    if (!response.success) throw new Error(`omp get_session_stats failed: ${String(response.error ?? "unknown error")}`);
    return (response.data ?? {}) as OmpSessionStats;
  }
  /** Query `get_subagents`; live subagent registry (fail-soft: [] when unavailable). */
  async getSubagents(): Promise<unknown[]> {
    try {
      const response = await this.send({ type: "get_subagents" });
      if (!response.success) return [];
      const data = response.data as { subagents?: unknown[] } | undefined;
      return data?.subagents ?? [];
    } catch {
      return [];
    }
  }

  /**
   * Start a turn with a user prompt. On an idle session `prompt` wakes the
   * agent and starts a fresh turn. Never send this while OMP is streaming:
   * without `streamingBehavior` OMP rejects it, and `prompt` with
   * `streamingBehavior: "followUp"` queues with `resumeIfIdle: false` (delivered
   * as a user message on idle, never auto-generating a turn).
   */
  prompt(message: string): Promise<RpcResponse> {
    return this.send({ type: "prompt", message });
  }

  /**
   * Queue a follow-up on a busy session. OMP delivers it as the next turn's
   * user message once the current turn ends AND auto-generates that turn —
   * the dedicated `follow_up` command's connection layer hardcodes
   * `resumeIfIdle: true` (unlike `prompt` + streamingBehavior). Verified
   * empirically: docs/probe-omp-followup.mjs.
   */
  followUp(message: string): Promise<RpcResponse> {
    return this.send({ type: "follow_up", message });
  }

  /** Steer an in-flight turn with a user message. */
  steer(message: string): Promise<RpcResponse> {
    return this.send({ type: "steer", message });
  }

  /** Select the active model by provider + model id (e.g. `deepseek`/`deepseek-v4-pro`). */
  setModel(provider: string, modelId: string): Promise<RpcResponse> {
    return this.send({ type: "set_model", provider, modelId });
  }

  /** Abort the current streaming run. */
  abort(): Promise<RpcResponse> {
    return this.send({ type: "abort" });
  }

  /** Discard the current conversation and start a fresh OMP session. */
  newSession(): Promise<RpcResponse> {
    return this.send({ type: "new_session" });
  }

  /** Terminate the child process tree. Idempotent. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    if (process.env.OMP_TRACE === "1") {
      process.stderr.write(`[omp-rpc ${Date.now() % 1_000_000}] close() stack=${new Error().stack?.split("\n").slice(1, 6).join(" <- ")}\n`);
    }
    this.#kill();
    this.#fail(new Error("omp rpc client closed"));
  }

  /** SIGTERM the process group, escalating to SIGKILL if it lingers. */
  #kill(): void {
    if (this.#killed) return;
    this.#killed = true;
    const pid = this.#proc.pid;
    if (pid === undefined) return;
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      return; // group already gone
    }
    this.#killTimer = setTimeout(() => {
      this.#killTimer = null;
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        // already dead
      }
    }, KILL_GRACE_MS);
  }

  #onData(chunk: string): void {
    this.#buffer += chunk;
    let index: number;
    while ((index = this.#buffer.indexOf("\n")) >= 0) {
      let line = this.#buffer.slice(0, index);
      this.#buffer = this.#buffer.slice(index + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line.trim() === "") continue;
      this.#onLine(line);
    }
    }

  #onLine(line: string): void {
    let record: RpcEvent;
    try {
      record = JSON.parse(line) as RpcEvent;
    } catch {
      return; // ignore malformed lines
    }
    if (record.type === "ready") {
      this.#readyResolve();
      return;
    }
    if (record.type === "response") {
      const response = record as unknown as RpcResponse;
      if (response.id !== undefined) {
        const pending = this.#pending.get(response.id);
        if (pending !== undefined) {
          this.#pending.delete(response.id);
          pending.clear();
          pending.resolve(response);
        }
      }
      return;
    }
    for (const listener of [...this.#listeners]) {
      try {
        listener(record);
      } catch (error) {
        // Listener failures are contained — one bad observer must not break the stream.
        process.stderr.write(`omp rpc listener error: ${String(error)}\n`);
      }
    }
  }

  #fail(error: Error): void {
    if (this.#failure !== null) return;
    this.#failure = error;
    // Reject an in-flight handshake immediately (fix: not just via the 30s timeout).
    this.#readyReject(error);
    for (const pending of this.#pending.values()) {
      pending.clear();
      pending.reject(error);
    }
    this.#pending.clear();
    // Any failure path (ready-timeout, pre-ready exit, spawn error) must also
    // terminate the child so no orphan keeps the session file held.
    this.#kill();
    for (const listener of [...this.#failureListeners]) {
      try {
        listener(error);
      } catch (listenerError) {
        process.stderr.write(`omp rpc failure listener error: ${String(listenerError)}\n`);
      }
    }
  }
}
