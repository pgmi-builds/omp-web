/**
 * Minimal in-memory inbox for the OMP agent shim.
 *
 * The 0.1.5 `dsh-agent` contract exposes the inbox as an interface
 * (`Inbox` in `runtime-types`); the durable projection-backed implementation
 * (`ReactLoopInbox`) lives inside the (disabled) `dsh-agent-loop`. OMP owns
 * its own transcript and the bridge delivers messages directly to the OMP
 * process (`OmpAgent.#deliver`), so this inbox is never queued into — it
 * exists to satisfy the `Agent` interface's `inbox` surface with correct
 * (empty) semantics: `nextTurn`/`nextStep` stay empty and every mutation is
 * a faithful in-memory splice.
 *
 * @module omp-web/inbox
 */
import type { Inbox as InboxContract, InboxTarget } from "@deepseek-ai/dsh-agent";
import type { UserMessage } from "@deepseek-ai/dsh-session";
import type { MessageId } from "@deepseek-ai/dsh-llm";

export class Inbox implements InboxContract {
  #nextTurn: UserMessage[] = [];
  #nextStep: UserMessage[] = [];

  get nextTurn(): readonly UserMessage[] {
    return this.#nextTurn;
  }

  get nextStep(): readonly UserMessage[] {
    return this.#nextStep;
  }

  clear(): void {
    this.#nextTurn = [];
    this.#nextStep = [];
  }

  append(target: InboxTarget, message: UserMessage): void {
    this.#list(target).push(message);
  }

  prepend(target: InboxTarget, message: UserMessage): void {
    this.#list(target).unshift(message);
  }

  replace(messageId: MessageId, newMessage: UserMessage): boolean {
    const list = this.#find(messageId);
    if (list === undefined) return false;
    const index = list.findIndex((message) => message.id === messageId);
    if (index < 0) return false;
    list.splice(index, 1, newMessage);
    return true;
  }

  remove(messageId: MessageId): boolean {
    const list = this.#find(messageId);
    if (list === undefined) return false;
    const index = list.findIndex((message) => message.id === messageId);
    if (index < 0) return false;
    list.splice(index, 1);
    return true;
  }

  splice(target: InboxTarget, start: number, deleteCount: number, inserted: UserMessage[]): UserMessage[] {
    return this.#list(target).splice(start, deleteCount, ...inserted);
  }

  #list(target: InboxTarget): UserMessage[] {
    return target === "next-turn" ? this.#nextTurn : this.#nextStep;
  }

  #find(messageId: MessageId): UserMessage[] | undefined {
    if (this.#nextTurn.some((message) => message.id === messageId)) return this.#nextTurn;
    if (this.#nextStep.some((message) => message.id === messageId)) return this.#nextStep;
    return undefined;
  }
}
