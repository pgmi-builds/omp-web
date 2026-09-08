/**
 * SDK-line replacement for `OmpRpcClient` (apps/omp-web/src/rpc.ts).
 *
 * Same public surface — `on` / `onFailure` / `sendRaw` / `send` / `getState`
 * / `getMessages` / `getSessionStats` / `getSubagents` / `prompt` / `followUp`
 * / `steer` / `setModel` / `abort` / `newSession` / `close` — so the ported
 * adapter layer (agent.ts / index.ts / …) compiles unchanged. Instead of one
 * `omp --mode rpc` child per session, all clients multiplex ONE bun sidecar
 * process that embeds the OMP agent core via the SDK (app-level
 * authStorage / modelRegistry are shared; sessions are handle-addressed).
 *
 * Type-only imports keep the OMP wire shapes identical to the RPC line.
 */
import type {
  OmpMessage,
  OmpSessionStats,
  OmpState,
  RpcEvent,
  RpcResponse,
} from "./rpc-types.js";
import { OmpSdkSidecar } from "./sidecar-client.js";

/**
 * Parse the CLI args the RPC line passed to `omp --mode rpc`. Only the subset
 * the bridge actually uses is understood; unknown flags fail loudly rather
 * than being silently dropped.
 */
function parseSpawnArgs(args: string[]): { approvalMode?: string; resumeFile?: string } {
  const out: { approvalMode?: string; resumeFile?: string } = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--approval-mode" && args[i + 1] !== undefined) {
      out.approvalMode = args[++i];
    } else if (args[i] === "--resume" && args[i + 1] !== undefined) {
      out.resumeFile = args[++i];
    } else {
      throw new Error(`OmpSdkClient: unsupported spawn arg "${args[i]}" (SDK line)`);
    }
  }
  return out;
}

/** Response-shape shim so RpcResponse-typed call sites keep compiling. */
function ok(command: string): RpcResponse {
  return { type: "response", command, success: true };
}

// ---------------------------------------------------------------------------
// Shared sidecar (module-level singleton, refcounted)
// ---------------------------------------------------------------------------

let shared: OmpSdkSidecar | null = null;
let sharedStart: Promise<void> | null = null;
let refcount = 0;

function acquire(): OmpSdkSidecar {
  if (shared === null) {
    shared = new OmpSdkSidecar();
    sharedStart = shared.start().then(() => undefined);
  }
  refcount++;
  return shared;
}

function release(): void {
  refcount = Math.max(0, refcount - 1);
  if (refcount === 0 && shared !== null) {
    const dying = shared;
    shared = null;
    sharedStart = null;
    void dying.stop();
  }
}

// ---------------------------------------------------------------------------

export class OmpSdkClient {
  readonly #sidecar: OmpSdkSidecar;
  readonly #handle: string;
  readonly #listeners = new Set<(event: RpcEvent) => void>();
  readonly #failureListeners = new Set<(error: Error) => void>();
  #closed = false;
  #failure: Error | null = null;
  readonly #unsub: () => void;

  private constructor(sidecar: OmpSdkSidecar, handle: string) {
    this.#sidecar = sidecar;
    this.#handle = handle;
    this.#unsub = sidecar.onEvent((frame) => {
      if (frame.sessionId !== this.#handle) return;
      const event = frame.payload as RpcEvent;
      if (event === null || typeof event !== "object" || typeof event.type !== "string") return;
      for (const listener of [...this.#listeners]) {
        try {
          listener(event);
        } catch (error) {
          process.stderr.write(`omp sdk listener error: ${String(error)}\n`);
        }
      }
    });
  }

  /**
   * Start a session on the shared sidecar and resolve once it is ready.
   * Mirrors `OmpRpcClient.spawn(args, cwd)`.
   */
  static async spawn(args: string[] = [], cwd?: string): Promise<OmpSdkClient> {
    const { approvalMode, resumeFile } = parseSpawnArgs(args);
    const sidecar = acquire();
    try {
      await sharedStart;
      const created = await sidecar.call<{ handle: string }>("session.create", {
        cwd,
        persistence: "file",
        ...(approvalMode === undefined ? {} : { approvalMode }),
        ...(resumeFile === undefined ? {} : { resumeFile }),
      });
      return new OmpSdkClient(sidecar, created.handle);
    } catch (error) {
      release();
      throw error;
    }
  }

  /** Register an OMP event listener; returns the unsubscriber. */
  on(listener: (event: RpcEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** Register a failure listener; returns the unsubscriber. */
  onFailure(listener: (error: Error) => void): () => void {
    this.#failureListeners.add(listener);
    return () => {
      this.#failureListeners.delete(listener);
    };
  }

  /**
   * Raw-command escape hatch. The SDK line has no stdio command channel, so
   * the RPC-specific `extension_ui_response` (approval-card answers) is
   * accepted and logged — approval flows route through SDK-side approval
   * events instead (parity work item, see README).
   */
  sendRaw(command: Record<string, unknown>): void {
    if (this.#failure !== null || this.#closed) return;
    if (process.env.OMP_TRACE === "1") {
      process.stderr.write(`[omp-sdk] sendRaw (no-op on SDK line): ${JSON.stringify(command).slice(0, 160)}\n`);
    }
  }

  /**
   * Generic command sender for compatibility. The RPC line's free-form
   * command channel does not exist here; supported commands are mapped onto
   * sidecar methods, everything else fails loudly.
   */
  async send(command: Record<string, unknown>): Promise<RpcResponse> {
    switch (command.type) {
      case "prompt":
        await this.prompt(String(command.message));
        return ok("prompt");
      case "steer":
        await this.steer(String(command.message));
        return ok("steer");
      case "follow_up":
        await this.followUp(String(command.message));
        return ok("follow_up");
      case "abort":
        await this.abort();
        return ok("abort");
      case "set_model":
        await this.setModel(String(command.provider), String(command.modelId));
        return ok("set_model");
      case "new_session":
        await this.newSession();
        return ok("new_session");
      case "get_state":
        return { type: "response", command: "get_state", success: true, data: await this.getState() };
      case "get_messages":
        return { type: "response", command: "get_messages", success: true, data: { messages: await this.getMessages() } };
      default:
        throw new Error(`OmpSdkClient.send: unsupported command "${String(command.type)}" (SDK line)`);
    }
  }

  /** Query session state; returns the `get_state`-shaped payload. */
  async getState(): Promise<OmpState> {
    const state = await this.#call<OmpState>("session.state");
    return state ?? { isStreaming: false };
  }

  /** Query the full conversation. */
  async getMessages(): Promise<OmpMessage[]> {
    const data = await this.#call<{ messages: OmpMessage[] }>("session.messages");
    return data?.messages ?? [];
  }

  /** Live token/context/cost accounting (live sessions only). */
  async getSessionStats(): Promise<OmpSessionStats> {
    return (await this.#call<OmpSessionStats>("session.stats")) ?? {};
  }

  /** Live subagent registry (fail-soft: [] until the SDK exposes it). */
  async getSubagents(): Promise<unknown[]> {
    try {
      const data = await this.#call<{ subagents?: unknown[] }>("session.subagents");
      return data?.subagents ?? [];
    } catch {
      return [];
    }
  }

  /** Start a turn with a user prompt (fire-and-forget acceptance). */
  async prompt(message: string): Promise<RpcResponse> {
    await this.#call("session.prompt", { text: message });
    return ok("prompt");
  }

  /** Queue a follow-up on a busy session. */
  async followUp(message: string): Promise<RpcResponse> {
    await this.#call("session.followUp", { text: message });
    return ok("follow_up");
  }

  /** Steer an in-flight turn. */
  async steer(message: string): Promise<RpcResponse> {
    await this.#call("session.steer", { text: message });
    return ok("steer");
  }

  /** Select the active model by provider + model id. */
  async setModel(provider: string, modelId: string): Promise<RpcResponse> {
    await this.#call("session.setModel", { provider, modelId });
    return ok("set_model");
  }

  /** Abort the current streaming run. */
  async abort(): Promise<RpcResponse> {
    await this.#call("session.abort");
    return ok("abort");
  }

  /** Discard the current conversation and start a fresh session (same handle). */
  async newSession(): Promise<RpcResponse> {
    await this.#call("session.new");
    return ok("new_session");
  }

  /** Dispose the session and release the shared sidecar. Idempotent. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#unsub();
    void this.#sidecar.call("session.dispose", { handle: this.#handle }).catch(() => {});
    release();
    this.#fail(new Error("omp sdk client closed"));
  }

  #call<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (this.#failure !== null) return Promise.reject(this.#failure);
    if (this.#closed) return Promise.reject(new Error("omp sdk client is closed"));
    return this.#sidecar.call<T>(method, { handle: this.#handle, ...(params as object) });
  }

  #fail(error: Error): void {
    if (this.#failure !== null) return;
    this.#failure = error;
    for (const listener of [...this.#failureListeners]) {
      try {
        listener(error);
      } catch (listenerError) {
        process.stderr.write(`omp sdk failure listener error: ${String(listenerError)}\n`);
      }
    }
  }
}
