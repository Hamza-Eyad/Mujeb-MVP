/** A plain text message: what the caller said, or what Mujeeb said (and the caller heard). */
export interface ChatMessage {
  role: 'user' | 'assistant';
  text: string;
}

/** A tool the model may call. `parameters` is a strict JSON Schema (all fields required, no extra properties). */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  callId: string;
  name: string;
  /** JSON-encoded arguments exactly as the model produced them. Validated by the tool, not here. */
  arguments: string;
}

export interface ToolResult {
  callId: string;
  /** JSON-encoded result for the model. */
  output: string;
}

/**
 * Provider state of one model round that ended in tool calls (e.g. reasoning items, assistant
 * messages with their phase, function-call items). Opaque: domain code stores it and hands it back
 * unchanged within the same user turn; only the adapter that produced it interprets it.
 */
export interface ModelContinuation {
  readonly provider: string;
  readonly model: string;
  readonly items: readonly unknown[];
}

/**
 * One model round that called tools, with the results of every call. Calls and results always travel
 * together so a call is never sent without its result.
 */
export interface ToolExchange {
  readonly type: 'tool_exchange';
  /** Never set. Declared so text-only code can read `role`/`text` from any item (undefined here). */
  readonly role?: undefined;
  readonly text?: undefined;
  readonly calls: readonly ToolCall[];
  readonly results: readonly ToolResult[];
  /** Present only for rounds of the current user turn; dropped when the turn is committed to history. */
  readonly continuation?: ModelContinuation;
}

export type ConversationItem = ChatMessage | ToolExchange;

export interface LlmRequest {
  instructions: string;
  messages: readonly ConversationItem[];
  /** Tools offered for this request. Absent/empty: a text-only request. */
  tools?: readonly ToolSpec[];
  /** `none`: the tools stay visible (earlier calls remain valid context) but this round must answer in text. Default `auto`. */
  toolChoice?: 'auto' | 'none';
}

export type LlmEvent =
  | { type: 'text_delta'; text: string }
  /**
   * End of the model round. `toolCalls` (and the `continuation` needed to continue this turn after
   * running them) are present only when the model called tools.
   */
  | { type: 'completed'; toolCalls?: readonly ToolCall[]; continuation?: ModelContinuation };

export interface LanguageModel {
  readonly name: string;
  /** Streams the response. Must stop promptly and reject when `signal` aborts. Errors are ProviderError. */
  stream(request: LlmRequest, options: { signal: AbortSignal }): AsyncIterable<LlmEvent>;
}

export function isChatMessage(item: ConversationItem): item is ChatMessage {
  return item.role !== undefined;
}
