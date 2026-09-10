/**
 * omp-web sidecar entry — run under bun.
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
import { createAgentSession, SessionManager, discoverAuthStorage, ModelRegistry, Settings, loadSessionMessagesReadOnly, parseSessionEntries } from "@oh-my-pi/pi-coding-agent";
import { PROTOCOL_VERSION, type EventFrame, type RequestFrame, type ResponseFrame } from "../dist/protocol.js";

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

// Lazily-cached PERSISTENT Settings instance for modelRoles writes. Cached so
// repeated writes reuse one instance (and one agent.db handle); the SDK's
// whole-object `set` captures the on-disk generation at write time, so a cached
// instance does NOT serve stale data to the generation check. (readOnly
// instances never persist, so a fresh instance is not an option here.)
let writableSettingsPromise: Promise<Settings> | null = null;
function getWritableSettings(): Promise<Settings> {
  if (writableSettingsPromise === null) {
    writableSettingsPromise = Settings.loadIsolated();
  }
  return writableSettingsPromise;
}

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

/** Normalize a SDK timestamp (Date | number | ISO string) to epoch ms. */
function toEpochMs(value: unknown): number | undefined {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") {
    const t = Date.parse(value);
    return Number.isFinite(t) ? t : undefined;
  }
  return undefined;
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
        ...(m.api !== undefined ? { api: m.api } : {}),
        ...(m.baseUrl !== undefined ? { baseUrl: m.baseUrl } : {}),
        ...(typeof m.reasoning === "boolean" ? { reasoning: m.reasoning } : {}),
        ...(Array.isArray(m.input) ? { input: m.input } : {}),
        ...(typeof m.contextWindow === "number"
          ? { contextWindow: m.contextWindow }
          : typeof m.context_length === "number"
            ? { contextWindow: m.context_length }
            : {}),
        ...(typeof m.maxTokens === "number" ? { maxTokens: m.maxTokens } : {}),
        ...(m.thinking !== null && typeof m.thinking === "object"
          ? {
              thinking: {
                ...(typeof m.thinking.mode === "string" ? { mode: m.thinking.mode } : {}),
                ...(Array.isArray(m.thinking.efforts) ? { efforts: m.thinking.efforts } : {}),
                ...(typeof m.thinking.defaultLevel === "string" ? { defaultLevel: m.thinking.defaultLevel } : {}),
              },
            }
          : {}),
      })),
      providers: [...new Set(all.map((m: any) => m.provider))],
    };
  },

  // ---- settings: modelRoles (A1) ----
  //
  // Read path reads FRESH on every call (Settings.loadReadOnly) rather than a
  // sidecar-cached Settings instance: the OMP TUI is a separate process that
  // rewrites config.yml when the operator changes the default model, and a
  // long-lived sidecar's cached Settings instance would keep serving the stale
  // in-memory value (the SDK does not watch config for a running session).
  // modelRoles reads happen at the bridge's reconcile-tick cadence (~30s), so a
  // fresh disk read per get is cheap and is the faithful equivalent of
  // `omp config get modelRoles --json`.
  "settings.modelRoles.get": async () => {
    const s = await Settings.loadReadOnly();
    return { modelRoles: s.getModelRoles() };
  },

  // Whole-object write, matching `omp config set modelRoles` (dotted keys are
  // rejected; the entire modelRoles object is the unit). `set()` + `flush()`
  // makes the write durable before we answer; the SDK re-reads config.yml under
  // a file lock and writes atomically, preserving a concurrent edit to a sibling
  // top-level key while modelRoles is replaced as a unit. A read-back confirms
  // the write actually landed (the SDK silently skips a stale generation), so
  // the bridge's shadow-key sync only advances on a real write.
  "settings.modelRoles.set": async ({ modelRoles }: any) => {
    if (modelRoles === null || typeof modelRoles !== "object" || Array.isArray(modelRoles)) {
      throw new Error("settings.modelRoles.set: modelRoles must be a record");
    }
    const s = await getWritableSettings();
    s.set("modelRoles", modelRoles as Record<string, string>);
    await s.flush();
    const fresh = await Settings.loadReadOnly();
    const onDisk = fresh.getModelRoles();
    return { ok: Bun.deepEquals(onDisk, modelRoles as Record<string, string>) };
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

  // Render the held session's full base system prompt (live path). The prompt
  // is lazy (a short placeholder until the first refresh), so force a rebuild
  // and return the rendered blocks joined into one text.
  "session.systemPrompt": async ({ handle }: any) => {
    const session: any = await get(handle);
    await session.refreshBaseSystemPrompt?.();
    const blocks = session.systemPrompt ?? session.state?.systemPrompt ?? [];
    const text = Array.isArray(blocks) ? blocks.join("\n\n") : String(blocks ?? "");
    return { systemPrompt: text };
  },

  // Render a cold session's system prompt from its transcript file. Deliberately
  // OUTSIDE the handle pool: a throwaway AgentSession is opened, refreshed, and
  // disposed without ever being hold()-ed, so it cannot collide with live handles.
  "session.systemPrompt.forFile": async ({ file }: any) => {
    const manager = await SessionManager.open(file, undefined, undefined, { suppressBreadcrumb: true });
    try {
      const { session } = await createAgentSession({ sessionManager: manager });
      try {
        await (session as any).refreshBaseSystemPrompt();
        const blocks = (session as any).systemPrompt ?? [];
        const text = Array.isArray(blocks) ? blocks.join("\n\n") : String(blocks ?? "");
        return { systemPrompt: text };
      } finally {
        // Read-only render: suppress the `session_exit` record that dispose()
        // otherwise appends when the transcript has assistant messages. Drop
        // the manager's retained entries first so the exit-record gate sees an
        // empty journal, then dispose() runs its full MCP/worker teardown
        // without writing to the transcript file.
        manager.releaseRetainedEntries();
        await (session as any).dispose();
      }
    } finally {
      await manager.close().catch(() => {});
    }
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
    // `SessionManager.listAll` takes no cwd — it walks the whole sessions root,
    // so the `all` branch must NOT pass the cwd through (the pre-P4 code did,
    // which fed the string into the `storage` slot and returned an empty list).
    const entries = all
      ? await SessionManager.listAll()
      : await SessionManager.list(cwd ?? process.cwd());
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

  // A6 — full-library native session index: one listAll across every cwd group.
  // Serialized as epoch ms so the Node side needs no Date/ISO ambiguity.
  "sessions.listAll": async () => {
    const arr = ((await SessionManager.listAll()) as any[]) ?? [];
    return {
      sessions: arr.map((e: any) => ({
        id: e.id,
        file: e.path ?? e.file,
        ...(typeof e.cwd === "string" ? { cwd: e.cwd } : {}),
        ...(typeof e.title === "string" && e.title !== "" ? { title: e.title } : {}),
        ...(typeof e.firstMessage === "string" && e.firstMessage !== "" ? { firstMessage: e.firstMessage } : {}),
        ...(e.created !== undefined ? { createdAt: toEpochMs(e.created) } : {}),
        ...(e.modified !== undefined ? { mtimeMs: toEpochMs(e.modified) } : {}),
        ...(typeof e.size === "number" ? { size: e.size } : {}),
      })),
    };
  },

  // A6 — read-only transcript extraction (resume/replay). Messages come from the
  // SDK's canonical reader (migration + blob refs + compaction aware); model
  // changes have no dedicated reader, so they are recovered from a lenient parse.
  "sessions.messagesReadOnly": async ({ file }: any) => {
    const messages = await loadSessionMessagesReadOnly(file);
    let modelChanges: Array<{ model: string; role?: string }> = [];
    try {
      const content = await Bun.file(file).text();
      const entries = parseSessionEntries(content);
      modelChanges = entries
        .filter((e: any) => e.type === "model_change" && typeof e.model === "string" && e.model !== "")
        .map((e: any) => ({ model: e.model, ...(typeof e.role === "string" ? { role: e.role } : {}) }));
    } catch {
      // model changes are optional — messages alone still serve replay.
    }
    return { messages, modelChanges };
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
