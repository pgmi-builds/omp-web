/**
 * LazyOmpRpc — the create-time placeholder that makes a freshly created Dash
 * session cost NOTHING on the backend (the "backend takes zero part in the
 * UI's draft" contract):
 *
 *   - constructing one spawns no OMP child, writes no transcript, no index
 *     row, and no session events — the session announces blank, exactly like
 *     the native agent-loop factory's in-process agent;
 *   - the shared-sidecar session materializes on the FIRST dispatch path
 *     (`prompt` / `followUp` / `steer` / `ensureStarted`);
 *   - passive queries (`getState` / `getSubagents` / `getSessionStats` /
 *     `getSystemPrompt` / `abort` / `sendRaw`) answer synthetically without
 *     spawning, so idle-exit revalidation, `whenIdle`, and avoidance checks
 *     can never conjure a child;
 *   - `close()` on a never-spawned wrapper is a no-op; a close racing an
 *     in-flight spawn disposes the child the moment it lands.
 *
 * A model selection made before the child exists (`setModel` from the pre-turn
 * sync) is parked and applied right after the spawn, ahead of the prompt.
 */
import type { OmpSessionStats, OmpState, RpcEvent } from "./rpc-types.js";
import { OmpSdkClient } from "./sdk-client.js";

/**
 * The client surface `OmpAgent` drives. `OmpSdkClient` satisfies this
 * structurally (plus `ensureStarted`/`spawned`, which are no-ops/trues there);
 * `LazyOmpRpc` implements it with deferred spawning.
 */
export interface OmpAgentRpc {
  on(listener: (event: RpcEvent) => void): () => void;
  onFailure(listener: (error: Error) => void): () => void;
  prompt(message: string): Promise<unknown>;
  followUp(message: string): Promise<unknown>;
  steer(message: string): Promise<unknown>;
  compact(instructions?: string): Promise<unknown>;
  contextUsage(): Promise<{ tokens?: number; percent?: number } | undefined>;
  abort(): Promise<unknown>;
  /** Forces the child to exist (first prompt). Never rejects for being live. */
  ensureStarted(): Promise<void>;
  /** Whether the child exists — passive paths key off this, never spawn. */
  readonly spawned: boolean;
  getState(): Promise<OmpState>;
  getSubagents(): Promise<unknown[]>;
  getSessionStats(): Promise<OmpSessionStats>;
  getSystemPrompt(): Promise<string | undefined>;
  setModel(provider: string, modelId: string): Promise<unknown>;
  sendRaw(command: Record<string, unknown>): void;
  close(): void;
}

/** Synthetic state for a not-yet-spawned child: quiescent by definition. */
const IDLE_STATE: OmpState = { isStreaming: false };

export class LazyOmpRpc implements OmpAgentRpc {
  readonly #spawnArgs: string[];
  readonly #cwd: string | undefined;
  #client: OmpSdkClient | undefined;
  #spawn: Promise<OmpSdkClient> | undefined;
  #closed = false;
  readonly #eventListeners = new Set<(event: RpcEvent) => void>();
  readonly #failureListeners = new Set<(error: Error) => void>();
  #pendingModel: { provider: string; modelId: string } | undefined;
  #onSpawned: ((client: OmpSdkClient) => void) | undefined;

  constructor(spawnArgs: string[], cwd?: string) {
    this.#spawnArgs = spawnArgs;
    this.#cwd = cwd;
  }

  /**
   * Bridge hook: runs once when the child first exists (the caller writes the
   * index row + supervisor held-baseline there — the create-time counterparts
   * were deliberately skipped). Registered before or after the spawn; both
   * orders fire exactly once.
   */
  onSpawned(handler: (client: OmpSdkClient) => void): void {
    this.#onSpawned = handler;
    if (this.#client !== undefined) handler(this.#client);
  }

  get spawned(): boolean {
    return this.#client !== undefined;
  }

  /** Spawn once; concurrent and later callers share the same child. */
  #ensure(): Promise<OmpSdkClient> {
    if (this.#client !== undefined) return Promise.resolve(this.#client);
    if (this.#spawn === undefined) {
      this.#spawn = OmpSdkClient.spawn(this.#spawnArgs, this.#cwd).then((client) => {
        // A close() that raced the in-flight spawn wins: dispose immediately.
        if (this.#closed) {
          client.close();
          return client;
        }
        this.#client = client;
        for (const listener of this.#eventListeners) client.on(listener);
        for (const listener of this.#failureListeners) client.onFailure(listener);
        this.#onSpawned?.(client);
        return client;
      }).catch((error: unknown) => {
        // Allow a later dispatch to retry the spawn.
        this.#spawn = undefined;
        throw error;
      });
    }
    return this.#spawn;
  }

  on(listener: (event: RpcEvent) => void): () => void {
    this.#eventListeners.add(listener);
    if (this.#client !== undefined) this.#client.on(listener);
    return () => {
      this.#eventListeners.delete(listener);
    };
  }

  onFailure(listener: (error: Error) => void): () => void {
    this.#failureListeners.add(listener);
    if (this.#client !== undefined) this.#client.onFailure(listener);
    return () => {
      this.#failureListeners.delete(listener);
    };
  }

  async prompt(message: string): Promise<unknown> {
    const client = await this.#ensure();
    // Apply a pre-spawn model selection now, ahead of the prompt (the sidecar
    // records it as the session's model_change, like a pre-turn set_model).
    const pending = this.#pendingModel;
    if (pending !== undefined) {
      this.#pendingModel = undefined;
      await client.setModel(pending.provider, pending.modelId).catch(() => {});
    }
    return client.prompt(message);
  }

  async followUp(message: string): Promise<unknown> {
    return (await this.#ensure()).followUp(message);
  }

  async steer(message: string): Promise<unknown> {
    return (await this.#ensure()).steer(message);
  }

  async compact(instructions?: string): Promise<unknown> {
    return (await this.#ensure()).compact(instructions);
  }

  async contextUsage(): Promise<{ tokens?: number; percent?: number } | undefined> {
    if (this.#client === undefined) return undefined;
    return this.#client.contextUsage();
  }

  async abort(): Promise<unknown> {
    if (this.#client === undefined) return undefined;
    return this.#client.abort();
  }

  async ensureStarted(): Promise<void> {
    await this.#ensure();
  }

  async getState(): Promise<OmpState> {
    if (this.#client === undefined) return IDLE_STATE;
    return this.#client.getState();
  }

  async getSubagents(): Promise<unknown[]> {
    if (this.#client === undefined) return [];
    return this.#client.getSubagents();
  }

  async getSessionStats(): Promise<OmpSessionStats> {
    if (this.#client === undefined) return {};
    return this.#client.getSessionStats();
  }

  async getSystemPrompt(): Promise<string | undefined> {
    if (this.#client === undefined) return undefined;
    return this.#client.getSystemPrompt();
  }

  async setModel(provider: string, modelId: string): Promise<unknown> {
    if (this.#client === undefined) {
      // Park it: applied by prompt() immediately after the spawn.
      this.#pendingModel = { provider, modelId };
      return undefined;
    }
    return this.#client.setModel(provider, modelId);
  }

  sendRaw(command: Record<string, unknown>): void {
    if (this.#client !== undefined) this.#client.sendRaw(command);
  }

  close(): void {
    this.#closed = true;
    const client = this.#client;
    this.#client = undefined;
    client?.close();
  }
}
