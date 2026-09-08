/**
 * omp-web-sdk sidecar protocol (v0).
 *
 * Transport: JSON lines over stdio of the bun sidecar process.
 *  - Node → sidecar: request  frame  { id, method, params }
 *  - sidecar → Node: response frame  { id, ok: true, result } | { id, ok: false, error }
 *  - sidecar → Node: event     frame  { event: "<channel>", sessionId?, payload }
 *  - Node → sidecar: notification    { method, params }  (no id, no response — e.g. session.prompt cancel is out of band via abort)
 *
 * Handshake: on start the sidecar pushes { event: "ready", payload: { protocol: 0, sdk: <version> } }.
 * Every request gets exactly one response, in any order (correlate by id).
 */

export const PROTOCOL_VERSION = 0;

export interface RequestFrame {
  id: number;
  method: string;
  params?: unknown;
}

export interface NotificationFrame {
  method: string;
  params?: unknown;
}

export type ResponseFrame =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string };

export interface EventFrame {
  event: string;
  sessionId?: string;
  payload: unknown;
}

// ---- method table (grows as A/S segments land) ----

export namespace methods {
  // sys
  export interface PingParams {}
  export interface PingResult { pong: true; sdk: string; bun: string }

  // A2/A3 — model registry / auth
  export interface ModelsListParams { refresh?: boolean }
  export interface ModelsListResult {
    models: Array<{ provider: string; id: string; name?: string; contextWindow?: number }>;
    providers: string[];
  }

  // A1 — settings
  export interface SettingsGetParams { key?: string }
  export interface SettingsGetResult { value: unknown }

  // session lifecycle (S-lane)
  export interface SessionCreateParams {
    /** in-memory by default; "file" = SessionManager.create(cwd) */
    persistence?: "memory" | "file";
    cwd?: string;
    /** provider/model selector, resolved the same way the CLI does */
    model?: string;
    systemPrompt?: string;
    appendSystemPrompt?: string;
  }
  export interface SessionCreateResult {
    sessionId: string;
    sessionFile?: string;
    model?: string;
  }

  export interface SessionDisposeParams { sessionId: string }
  export interface SessionDisposeResult { disposed: true }

  export interface SessionInfoParams { sessionId: string }
  export interface SessionInfoResult {
    sessionId: string;
    sessionFile?: string;
    model?: string;
    thinkingLevel?: string;
    isStreaming: boolean;
    messageCount: number;
    /** rendered system prompt (lazy — may be short until first turn) */
    systemPromptBytes: number;
  }

  export interface SessionPromptParams {
    sessionId: string;
    text: string;
    streamingBehavior?: "steer" | "followUp";
  }
  export interface SessionPromptResult { accepted: boolean }

  export interface SessionSteerParams { sessionId: string; text: string }
  export interface SessionFollowUpParams { sessionId: string; text: string }
  export interface SessionAbortParams { sessionId: string }

  /** A5 — session store index */
  export interface SessionsListParams { cwd?: string; all?: boolean }
  export interface SessionsListResult {
    sessions: Array<{ id: string; file: string; title?: string; timestamp?: string }>;
  }
}

/** event channels forwarded from AgentSession.subscribe */
export type SessionEventChannel = "session:event";
