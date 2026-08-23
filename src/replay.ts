/**
 * Replay OMP's `get_messages` transcript into Dash `SessionEvent` seeds.
 *
 * OMP owns the agent transcript; on resume we reconstruct a fresh Dash session
 * log from it. `get_messages` returns a flat list of `user` / `assistant` /
 * `toolResult` messages in append order (no turn/step markers), so boundaries
 * are re-synthesized with the same shape the live bridge (`OmpAgent`) produces:
 *
 *   - one Dash turn per `user` message,
 *   - one Dash step per `assistant` message (one model call + its tool results),
 *   - `tool/result` events belong to the open step that requested the call.
 *
 * The emitted events carry contiguous `seq` from 0 and safe-integer `time`
 * values, exactly what `Session`'s seed validator requires.
 */
import { CallId, createAssistantMessage, createToolResultMessage, createUserMessage } from "@deepseek-ai/dsh-llm";
import type { SessionEvent, TurnEndReason } from "@deepseek-ai/dsh-session";
import type { OmpMessage } from "./rpc.js";
import { convertContent, convertUsage } from "./agent.js";

/** The OMP tool-call block shape inside an assistant message's content. */
interface OmpToolCallBlock {
  type: "toolCall";
  id?: unknown;
  name?: unknown;
  arguments?: unknown;
}

export function replayOmpMessages(messages: OmpMessage[]): SessionEvent[] {
  const events: SessionEvent[] = [];
  let seq = 0;
  let turn = 0;
  let step = 0;
  let turnOpen = false;
  let stepOpen = false;
  let time = Date.now();

  const push = (
    type: string,
    data: Record<string, unknown>,
    surface?: { surfaceOp: "append"; sourceEventSeqs?: number[] },
  ): void => {
    events.push({ type, seq: seq++, time: time++, data, ...(surface ?? {}) } as unknown as SessionEvent);
  };

  const closeStep = (): void => {
    if (!stepOpen) return;
    stepOpen = false;
    push("step/end", { turn, step });
  };

  const closeTurn = (): void => {
    closeStep();
    if (!turnOpen) return;
    turnOpen = false;
    push("turn/end", { turn, reason: { kind: "completed" } as TurnEndReason });
  };

  for (const message of messages) {
    switch (message.role) {
      case "user": {
        closeTurn();
        turn += 1;
        step = 0;
        turnOpen = true;
        push("turn/start", { turn });
        const user = createUserMessage({ content: convertContent(message.content), source: { kind: "user" } });
        push("user/message", user as unknown as Record<string, unknown>, { surfaceOp: "append" });
        break;
      }

      case "assistant": {
        closeStep();
        if (!turnOpen) {
          turn += 1;
          step = 0;
          turnOpen = true;
          push("turn/start", { turn });
        }
        step += 1;
        stepOpen = true;
        push("step/start", { turn, step });
        for (const block of (message.content ?? []) as OmpToolCallBlock[]) {
          if (block.type !== "toolCall") continue;
          const callId = CallId(typeof block.id === "string" ? block.id : "");
          const name = typeof block.name === "string" ? block.name : "";
          const args = typeof block.arguments === "string" ? block.arguments : JSON.stringify(block.arguments ?? {});
          push("tool/call", { turn, step, callId, name, arguments: args });
        }
        const assistant = createAssistantMessage({
          content: convertContent(message.content),
          source: {
            provider: String(message.provider ?? ""),
            model: String(message.model ?? ""),
          },
        });
        const usage = convertUsage(message.usage);
        push(
          "assistant/message",
          { turn, step, message: assistant, ...(usage === undefined ? {} : { usage }) },
          { surfaceOp: "append", sourceEventSeqs: [] },
        );
        break;
      }

      case "toolResult": {
        if (!stepOpen) {
          step += 1;
          stepOpen = true;
          push("step/start", { turn, step });
        }
        const callId = CallId(String(message.toolCallId ?? ""));
        const isError = Boolean(message.isError ?? false);
        const result = createToolResultMessage({ callId, content: convertContent(message.content), isError });
        push(
          "tool/result",
          { turn, step, message: result, ...(isError ? { error: { name: "ToolExecutionError", code: "TOOL_ERROR" } } : {}) },
          { surfaceOp: "append" },
        );
        break;
      }

      default:
        break;
    }
  }

  closeTurn();
  return events;
}

/**
 * Compose the full cold Dash event log for one OMP transcript: an optional
 * leading `session/title` event (so the sidebar title projection folds
 * immediately, pinned `user`-sourced so Dash's own generator never fights
 * OMP's title authority) followed by the message replay, with contiguous
 * `seq` renumbered from 0.
 */
export function replayOmpTranscript(messages: OmpMessage[], title?: string, titleTime?: number): SessionEvent[] {
  const replayed = replayOmpMessages(messages);
  if (title === undefined || title.length === 0) return replayed;
  const events: SessionEvent[] = [
    {
      type: "session/title",
      seq: 0,
      time: titleTime ?? replayed[0]?.time ?? Date.now(),
      data: { title, messageSeqs: [], source: { kind: "user" } },
    } as unknown as SessionEvent,
    ...replayed,
  ];
  return events.map((event, index) => ({ ...event, seq: index }));
}
