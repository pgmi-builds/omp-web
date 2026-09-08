/**
 * Node-side client for the omp-web-sdk bun sidecar.
 * Spawns `bun run sidecar/main.ts`, speaks the v0 JSON-lines protocol,
 * correlates requests by id and dispatches pushed event frames.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PROTOCOL_VERSION,
  type EventFrame,
  type RequestFrame,
  type ResponseFrame,
} from "./protocol.js";

const require = createRequire(import.meta.url);
const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export interface SidecarOptions {
  ompHome?: string;
  cwd?: string;
  /** extra env for the sidecar process */
  env?: Record<string, string>;
}

export class OmpSdkSidecar {
  private proc: ChildProcess | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private eventHandlers = new Set<(frame: EventFrame) => void>();
  private readyPromise: Promise<{ protocol: number }> | null = null;
  private buffer = "";
  private startError: string | null = null;

  constructor(private options: SidecarOptions = {}) {}

  get started(): boolean {
    return this.proc !== null;
  }

  onEvent(handler: (frame: EventFrame) => void): () => void {
    this.eventHandlers.add(handler);
    return () => this.eventHandlers.delete(handler);
  }

  async start(): Promise<{ protocol: number }> {
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = new Promise<{ protocol: number }>((resolve, reject) => {
      const bunBin = path.join(pkgDir, "node_modules", ".bin", "bun");
      const sidecarEntry = path.join(pkgDir, "sidecar", "main.ts");
      const env: Record<string, string> = {
        ...process.env,
        ...(this.options.ompHome ? { OMP_HOME: this.options.ompHome } : {}),
        ...this.options.env,
      } as Record<string, string>;
      let proc: ChildProcess;
      try {
        proc = spawn(bunBin, ["run", sidecarEntry], {
          cwd: this.options.cwd ?? pkgDir,
          env,
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch (err: any) {
        reject(new Error(`failed to spawn bun sidecar: ${err.message}`));
        return;
      }
      this.proc = proc;

      const timeout = setTimeout(
        () => reject(new Error(`sidecar ready timeout (60s): ${this.startError ?? "no output"}`)),
        60_000,
      );
      const settle = (fn: () => void) => { clearTimeout(timeout); fn(); };

      proc.stdout!.setEncoding("utf8");
      proc.stdout!.on("data", (chunk: string) => this.consume(chunk, (r) => settle(() => resolve(r))));
      proc.stderr!.setEncoding("utf8");
      proc.stderr!.on("data", (chunk: string) => {
        this.startError = (this.startError ?? "") + chunk;
        process.stderr.write(`[omp-sdk-sidecar] ${chunk}`);
      });
      proc.on("exit", (code, signal) => {
        settle(() => reject(new Error(`sidecar exited before ready (${code ?? signal}): ${this.startError ?? ""}`)));
        for (const [, p] of this.pending) p.reject(new Error(`sidecar exited (${code ?? signal})`));
        this.pending.clear();
        this.proc = null;
      });
    });
    return this.readyPromise;
  }

  private consume(chunk: string, onReady?: (r: { protocol: number }) => void) {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) >= 0) {
      const raw = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!raw) continue;
      let frame: any;
      try {
        frame = JSON.parse(raw);
      } catch {
        continue;
      }
      if (frame.event === "ready") {
        onReady?.({ protocol: frame.payload?.protocol ?? PROTOCOL_VERSION });
        continue;
      }
      if (typeof frame.id === "number" && ("ok" in frame)) {
        const p = this.pending.get(frame.id);
        if (p) {
          this.pending.delete(frame.id);
          if (frame.ok) p.resolve(frame.result);
          else p.reject(new Error(frame.error));
        }
        continue;
      }
      if (frame.event) {
        for (const h of this.eventHandlers) h(frame as EventFrame);
      }
    }
  }

  call<T = any>(method: string, params?: unknown): Promise<T> {
    if (!this.proc?.stdin) return Promise.reject(new Error("sidecar not started"));
    const id = this.nextId++;
    const frame: RequestFrame = { id, method, params };
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.proc!.stdin!.write(JSON.stringify(frame) + "\n");
    });
  }

  notify(method: string, params?: unknown): void {
    if (!this.proc?.stdin) return;
    this.proc.stdin.write(JSON.stringify({ method, params }) + "\n");
  }

  async stop(): Promise<void> {
    const proc = this.proc;
    if (!proc) return;
    this.proc = null;
    await new Promise<void>((resolve) => {
      proc.once("exit", () => resolve());
      proc.stdin!.end();
      setTimeout(() => {
        proc.kill("SIGTERM");
        setTimeout(() => proc.kill("SIGKILL"), 3000);
      }, 3000).unref?.();
    });
  }
}
