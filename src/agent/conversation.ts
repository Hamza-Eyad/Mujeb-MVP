import { type ChatMessage, type ConversationItem, type LlmRequest, type ToolExchange, type ToolSpec, isChatMessage } from '../ports/language-model.js';

/**
 * Conversation state owned by Mujeeb, never by the model provider (requests carry the history;
 * providers are asked not to store it).
 * Knows nothing about audio. History is bounded to keep requests small and latency stable, and is
 * trimmed by whole turns so a tool call never loses its result or its user message.
 * A user message is committed only once its turn resolves, so a reply abandoned because the
 * user kept talking never leaves a duplicate or orphan message behind.
 *
 * Tool rounds of the turn in progress are passed to `request()` with their provider continuation and
 * replayed verbatim; once the turn is committed they are stored compactly (calls and results only).
 */
export class Conversation {
  private readonly items: ConversationItem[] = [];
  private readonly instructions: string;
  private readonly maxTurns: number;

  constructor(options: { instructions: string; maxTurns: number }) {
    this.instructions = options.instructions;
    this.maxTurns = Math.max(1, options.maxTurns);
  }

  addUser(text: string): void {
    const trimmed = text.trim();
    if (trimmed !== '') this.push({ role: 'user', text: trimmed });
  }

  /** Records only what the caller actually heard. Interrupted replies are marked for the model. */
  addAssistant(text: string, options?: { interrupted?: boolean }): void {
    const trimmed = text.trim();
    if (trimmed === '' && !options?.interrupted) return;
    const marker = options?.interrupted ? ' [قاطعه المتصل هنا]' : '';
    this.push({ role: 'assistant', text: `${trimmed}${marker}`.trim() });
  }

  /** Records a finished tool round. Provider continuation is dropped: earlier turns are kept compact. */
  addToolExchange(exchange: ToolExchange): void {
    assertComplete(exchange);
    this.push({ type: 'tool_exchange', calls: exchange.calls, results: exchange.results });
  }

  /** Commits a whole turn: what the caller said, the tool rounds it took, and what the caller heard. */
  commitTurn(turn: { user: string; exchanges?: readonly ToolExchange[]; assistant: string; interrupted?: boolean }): void {
    this.addUser(turn.user);
    for (const exchange of turn.exchanges ?? []) this.addToolExchange(exchange);
    this.addAssistant(turn.assistant, turn.interrupted ? { interrupted: true } : undefined);
  }

  /**
   * Request for the next model round. `pendingUser` is the not-yet-committed user utterance;
   * `currentTurn` the tool rounds already done in this turn (replayed with their continuation);
   * `context` extra per-request instructions (e.g. the current date and time).
   */
  request(
    pendingUser?: string,
    options?: { currentTurn?: readonly ToolExchange[]; tools?: readonly ToolSpec[]; toolChoice?: 'auto' | 'none'; context?: string },
  ): LlmRequest {
    const messages: ConversationItem[] = [...this.items];
    if (pendingUser !== undefined && pendingUser.trim() !== '') messages.push({ role: 'user', text: pendingUser.trim() });
    for (const exchange of options?.currentTurn ?? []) {
      assertComplete(exchange);
      messages.push(exchange);
    }
    const context = options?.context?.trim();
    return {
      instructions: context ? `${this.instructions}\n\n${context}` : this.instructions,
      messages,
      ...(options?.tools !== undefined && options.tools.length > 0
        ? { tools: options.tools, ...(options.toolChoice !== undefined ? { toolChoice: options.toolChoice } : {}) }
        : {}),
    };
  }

  /** The spoken transcript (user and assistant text only). */
  snapshot(): readonly ChatMessage[] {
    return this.items.filter(isChatMessage);
  }

  /** Everything the model sees from earlier turns, including compact tool rounds. */
  entries(): readonly ConversationItem[] {
    return [...this.items];
  }

  private push(item: ConversationItem): void {
    this.items.push(item);
    // Drop the oldest whole turn (and anything before it, e.g. the greeting) while over budget.
    while (this.userTurns() > this.maxTurns) {
      const first = this.items.findIndex(isUserMessage);
      const second = this.items.findIndex((it, i) => i > first && isUserMessage(it));
      this.items.splice(0, second);
    }
  }

  private userTurns(): number {
    return this.items.filter(isUserMessage).length;
  }
}

function isUserMessage(item: ConversationItem): boolean {
  return isChatMessage(item) && item.role === 'user';
}

function assertComplete(exchange: ToolExchange): void {
  const answered = new Set(exchange.results.map((r) => r.callId));
  const missing = exchange.calls.filter((c) => !answered.has(c.callId)).map((c) => c.callId);
  if (missing.length > 0 || exchange.calls.length === 0) {
    throw new Error(`Tool exchange must answer every call (missing: ${missing.join(', ') || 'no calls'})`);
  }
}
