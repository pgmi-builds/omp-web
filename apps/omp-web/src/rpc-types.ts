/**
 * OMP wire-shape types, shared verbatim with the RPC line
 * (apps/omp-web/src/rpc.ts) so both clients speak identical payload shapes.
 */
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

