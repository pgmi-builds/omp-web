/**
 * omp-web-sdk sidecar entry — run under bun.
 *
 *   OMP_HOME=~/.omp bun run sidecar/main.ts
 *
 * Wraps @oh-my-pi/pi-coding-agent and speaks the v0 JSON-lines protocol
 * defined in ./protocol.ts. One sidecar = one OMP "app instance":
 * shared authStorage / modelRegistry across all sessions it hosts.
 */
import { createAgentSession, SessionManager, discoverAuthStorage, ModelRegistry, Settings } from "@oh-my-pi/pi-coding-agent";
import { PROTOCOL_VERSION, type EventFrame, type RequestFrame, type ResponseFrame } from "../src/protocol.ts";

// ---------- outbound ----------

function send(frame: ResponseFrame | EventFrame): void {
  process.stdout.write(JSON.stringify(frame) + "\n");
}

function emitEvent(event: string, payload: unknown, sessionId?: string): void {
  send({ event, payload, ...(sessionId ? { sessionId } : {}) });
}

// ---------- shared app-level state (A-lane) ----------

const piPkg = (await import("@oh-my-pi/pi-coding-agent/package.json")) as any;
const PKG_VERSION: string = piPkg?.default?.version ?? piPkg?.version ?? "unknown";

const authStorage = await discoverAuthStorage();
const modelRegistry = new ModelRegistry(authStorage);
// kick off background refresh; models.list(refresh:true) can force a fresh one
void (modelRegistry as any).refreshInBackground?.()?.catch?.(() => {});

interface HeldSession {
  session: Awaited<ReturnType<typeof createAgentSession>>["session"];
  unsubscribe: () => void;
}
const sessions = new Map<string, HeldSession>();

function hold(sessionId: string, held: HeldSession) {
  sessions.set(sessionId, held);
}
async function get(sessionId: string) {
  const held = sessions.get(sessionId);
  if (!held) throw new Error(`unknown sessionId: ${sessionId}`);
  return held.session;
}

// ---------- method implementations ----------

type Handler = (params: any) => Promise<unknown>;

const table: Record<string, Handler> = {
  "sys.ping": async () => ({
    pong: true,
    sdk: PKG_VERSION,
    bun: Bun.version,
  }),

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

  "settings.get": async ({ key }: { key?: string }) => {
    // effective merged settings via the discovered Settings instance
    const settings = await Settings.init();
    const value = key ? settings.get?.(key) : undefined;
    return { value: value ?? null };
  },

  "session.create": async ({ persistence = "memory", cwd, model, systemPrompt, appendSystemPrompt }: any) => {
    const sessionManager =
      persistence === "file" ? SessionManager.create(cwd ?? process.cwd()) : SessionManager.inMemory();
    const { session } = await createAgentSession({
      sessionManager,
      ...(model ? { model: modelRegistry.find?.(model) ?? (model as any) } : {}),
      ...(systemPrompt !== undefined ? { systemPrompt } : {}),
      ...(appendSystemPrompt !== undefined ? { appendSystemPrompt } : {}),
    });
    const unsubscribe = session.subscribe((event: any) => {
      send({ event: "session:event", sessionId: session.sessionId, payload: event });
    });
    hold(session.sessionId, { session, unsubscribe });
    return {
      sessionId: session.sessionId,
      sessionFile: session.sessionFile ?? undefined,
      model: session.model ? `${(session.model as any).provider}/${(session.model as any).id}` : undefined,
    };
  },

  "session.dispose": async ({ sessionId }: any) => {
    const held = sessions.get(sessionId);
    if (!held) return { disposed: true };
    sessions.delete(sessionId);
    held.unsubscribe();
    await held.session.dispose();
    return { disposed: true };
  },

  "session.info": async ({ sessionId }: any) => {
    const session = await get(sessionId);
    return {
      sessionId: session.sessionId,
      sessionFile: session.sessionFile ?? undefined,
      model: session.model ? `${(session.model as any).provider}/${(session.model as any).id}` : undefined,
      thinkingLevel: String(session.thinkingLevel),
      isStreaming: session.isStreaming,
      messageCount: session.messages.length,
      systemPromptBytes: (session.systemPrompt ?? "").length,
    };
  },

  "session.prompt": async ({ sessionId, text, streamingBehavior }: any) => {
    const session = await get(sessionId);
    // fire-and-resolve-on-settle: prompt() awaits the full turn; the host sees
    // streaming through session:event frames in the meantime.
    void session.prompt(text, streamingBehavior ? { streamingBehavior } : undefined);
    return { accepted: true };
  },

  "session.steer": async ({ sessionId, text }: any) => {
    const session = await get(sessionId);
    await session.steer(text);
    return { accepted: true };
  },

  "session.followUp": async ({ sessionId, text }: any) => {
    const session = await get(sessionId);
    await session.followUp(text);
    return { accepted: true };
  },

  "session.abort": async ({ sessionId }: any) => {
    const session = await get(sessionId);
    await session.abort();
    return { accepted: true };
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
  // notifications (no id) are accepted but have no handlers yet
}

process.stdin.on("end", () => {
  void (async () => {
    for (const [id, held] of sessions) {
      try {
        held.unsubscribe();
        await held.session.dispose();
      } catch {}
    }
    process.exit(0);
  })();
});

emitEvent("ready", {
  protocol: PROTOCOL_VERSION,
  sdk: "see sys.ping",
  sessions: 0,
});
