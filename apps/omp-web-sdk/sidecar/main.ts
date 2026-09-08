/**
 * omp-web-sdk sidecar entry — run under bun.
 *
 *   OMP_HOME=~/.omp bun run sidecar/main.ts
 *
 * Wraps @oh-my-pi/pi-coding-agent and speaks the v0 JSON-lines protocol
 * defined in ../src/protocol.ts. One sidecar = one OMP "app instance":
 * shared authStorage / modelRegistry across all sessions it hosts.
 *
 * Sessions are addressed by a sidecar-minted `handle` (h1, h2, ...) rather
 * than the OMP session id, because AgentSession-level operations
 * (newSession / switchSession / fork) mint a NEW OMP session id while the
 * bridge-side handle must stay stable for the lifetime of the client.
 */
import { createAgentSession, SessionManager, discoverAuthStorage, ModelRegistry } from "@oh-my-pi/pi-coding-agent";
import { PROTOCOL_VERSION, type EventFrame, type RequestFrame, type ResponseFrame } from "../src/protocol.ts";

// ---------- outbound ----------

function send(frame: ResponseFrame | EventFrame): void {
  process.stdout.write(JSON.stringify(frame) + "\n");
}

// ---------- shared app-level state (A-lane) ----------

const piPkg = (await import("@oh-my-pi/pi-coding-agent/package.json")) as any;
const PKG_VERSION: string = piPkg?.default?.version ?? piPkg?.version ?? "unknown";

const authStorage = await discoverAuthStorage();
const modelRegistry = new ModelRegistry(authStorage);
void (modelRegistry as any).refreshInBackground?.()?.catch?.(() => {});

interface HeldSession {
  session: Awaited<ReturnType<typeof createAgentSession>>["session"];
  unsubscribe: () => void;
}
const sessions = new Map<string, HeldSession>();
let nextHandle = 0;

function hold(session: HeldSession["session"]): string {
  const handle = `h${++nextHandle}`;
  const unsubscribe = session.subscribe((event: any) => {
    send({ event: "session:event", sessionId: handle, payload: event });
  });
  sessions.set(handle, { session, unsubscribe });
  return handle;
}

async function get(handle: string) {
  const held = sessions.get(handle);
  if (!held) throw new Error(`unknown session handle: ${handle}`);
  return held.session;
}

function drop(handle: string): HeldSession | undefined {
  const held = sessions.get(handle);
  if (held) sessions.delete(handle);
  return held;
}

async function createSession(params: any): Promise<string> {
  const opts: Record<string, unknown> = {};
  if (params?.cwd) opts.cwd = params.cwd;
  if (params?.model) {
    const found = modelRegistry.find?.(params.model);
    if (found) opts.model = found;
  }
  if (params?.systemPrompt !== undefined) opts.systemPrompt = params.systemPrompt;
  if (params?.appendSystemPrompt !== undefined) opts.appendSystemPrompt = params.appendSystemPrompt;
  // approval parity with `omp --approval-mode`: yolo = fully auto-approved.
  if (params?.approvalMode === "yolo") opts.autoApprove = true;
  if (params?.resumeFile) opts.sessionManager = SessionManager.open(params.resumeFile);
  else if (params?.persistence === "file") opts.sessionManager = SessionManager.create(params.cwd ?? process.cwd());
  else opts.sessionManager = SessionManager.inMemory();

  const { session } = await createAgentSession(opts as any);
  return hold(session);
}

function describe(session: HeldSession["session"]) {
  const model: any = session.model;
  return {
    sessionId: session.sessionId,
    sessionFile: session.sessionFile ?? undefined,
    model: model ? { id: model.id, provider: model.provider, name: model.name } : undefined,
    thinkingLevel: String(session.thinkingLevel),
    isStreaming: session.isStreaming,
    messageCount: session.messages.length,
  };
}

// ---------- method implementations ----------

type Handler = (params: any) => Promise<unknown>;

const table: Record<string, Handler> = {
  "sys.ping": async () => ({ pong: true, sdk: PKG_VERSION, bun: Bun.version }),

  "models.list": async ({ refresh }: { refresh?: boolean }) => {
    if (refresh) await modelRegistry.refresh();
    const all = modelRegistry.getAvailable();
    return {
      models: all.map((m: any) => ({
        provider: m.provider,
        id: m.id,
        name: m.name,
        contextWindow: m.contextWindow ?? m.context_length,
      })),
      providers: [...new Set(all.map((m: any) => m.provider))],
    };
  },

  "session.create": async (params) => {
    const handle = await createSession(params);
    return { handle, ...describe(await get(handle)) };
  },

  "session.dispose": async ({ handle }: any) => {
    const held = drop(handle);
    if (!held) return { disposed: true };
    held.unsubscribe();
    await held.session.dispose();
    return { disposed: true };
  },

  // get_state parity
  "session.state": async ({ handle }: any) => describe(await get(handle)),

  // get_messages parity
  "session.messages": async ({ handle }: any) => {
    const session = await get(handle);
    return { messages: session.messages };
  },

  // get_session_stats parity (live sessions)
  "session.stats": async ({ handle }: any) => {
    const session: any = await get(handle);
    try {
      return (await session.getSessionStats?.()) ?? {};
    } catch {
      return {};
    }
  },

  // get_subagents parity — SDK subagent registry exposure TBD; fail-soft.
  "session.subagents": async () => ({ subagents: [] }),

  "session.prompt": async ({ handle, text, streamingBehavior }: any) => {
    const session = await get(handle);
    // Fire-and-forget, mirroring RPC's prompt semantics: the response reports
    // acceptance only; the turn itself streams through session:event frames.
    // Turn-level failures arrive as events (`message_update` error / notice).
    void Promise.resolve(
      session.prompt(text, streamingBehavior ? { streamingBehavior } : undefined),
    ).catch(() => {});
    return { accepted: true };
  },

  "session.steer": async ({ handle, text }: any) => {
    const session = await get(handle);
    await session.steer(text);
    return { accepted: true };
  },

  "session.followUp": async ({ handle, text }: any) => {
    const session = await get(handle);
    await session.followUp(text);
    return { accepted: true };
  },

  "session.abort": async ({ handle }: any) => {
    const session = await get(handle);
    await session.abort();
    return { accepted: true };
  },

  "session.setModel": async ({ handle, provider, modelId }: any) => {
    const session = await get(handle);
    const all = modelRegistry.getAvailable();
    const target = all.find((m: any) => m.provider === provider && m.id === modelId);
    if (!target) throw new Error(`model not available: ${provider}/${modelId}`);
    await session.setModel(target as any);
    return { accepted: true };
  },

  // new_session parity: replace the held AgentSession with a fresh one under
  // the same handle. The old session is disposed after the swap.
  "session.new": async ({ handle, cwd }: any) => {
    const held = sessions.get(handle);
    if (!held) throw new Error(`unknown session handle: ${handle}`);
    const fresh = await createSession({ cwd: cwd ?? (held.session as any).cwd ?? process.cwd(), persistence: "file" });
    // hold() minted a new handle for the fresh session; steal its entry.
    const freshHeld = drop(fresh)!;
    held.unsubscribe();
    sessions.set(handle, freshHeld);
    try { await held.session.dispose(); } catch {}
    return describe(freshHeld.session);
  },

  "sessions.list": async ({ cwd, all }: any) => {
    const dir = cwd ?? process.cwd();
    const entries = all ? await SessionManager.listAll(dir) : await SessionManager.list(dir);
    const arr = (entries as any[]) ?? [];
    return {
      sessions: arr.map((e: any) => ({
        id: e.id ?? e.sessionId,
        file: e.file ?? e.path,
        title: e.title,
        timestamp: e.timestamp,
      })),
    };
  },
};

// ---------- inbound loop ----------

const decoder = new TextDecoder();
let buffer = "";
process.stdin.on("data", (chunk: Uint8Array) => {
  buffer += decoder.decode(chunk, { stream: true });
  let nl: number;
  while ((nl = buffer.indexOf("\n")) >= 0) {
    const raw = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!raw) continue;
    void handleRaw(raw);
  }
});

async function handleRaw(raw: string): Promise<void> {
  let frame: any;
  try {
    frame = JSON.parse(raw);
  } catch {
    send({ id: -1, ok: false, error: `malformed frame: ${raw.slice(0, 120)}` });
    return;
  }
  if (frame?.method && typeof frame.id === "number") {
    const handler = table[frame.method];
    if (!handler) {
      send({ id: frame.id, ok: false, error: `unknown method: ${frame.method}` });
      return;
    }
    try {
      const result = await handler(frame.params ?? {});
      send({ id: frame.id, ok: true, result });
    } catch (err: any) {
      send({ id: frame.id, ok: false, error: String(err?.message ?? err) });
    }
  }
}

process.stdin.on("end", () => {
  void (async () => {
    for (const [, held] of sessions) {
      try {
        held.unsubscribe();
        await held.session.dispose();
      } catch {}
    }
    process.exit(0);
  })();
});

send({ event: "ready", payload: { protocol: PROTOCOL_VERSION, sdk: PKG_VERSION, sessions: 0 } });
