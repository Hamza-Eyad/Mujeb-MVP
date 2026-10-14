import OpenAI, {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
  AuthenticationError,
  BadRequestError,
  InternalServerError,
  PermissionDeniedError,
  RateLimitError,
} from 'openai';
import type { FunctionTool, ResponseInputItem, ResponseOutputItem } from 'openai/resources/responses/responses';
import { abortReason } from '../../core/async.js';
import { ProviderError, type ProviderErrorKind } from '../../core/errors.js';
import { type ConversationItem, type LanguageModel, type LlmEvent, type LlmRequest, type ToolSpec, isChatMessage } from '../../ports/language-model.js';

/**
 * OpenAI Responses API (streaming). Mujeeb owns the conversation: every request carries the
 * history it needs and runs with `store: false` (no server-side state, no previous_response_id).
 *
 * Function calling with `store: false` (DECISIONS A18): when a round ends in function calls, its output
 * items (reasoning with `encrypted_content`, assistant messages with their `phase`, function calls) go
 * back to the caller as an opaque continuation. Within the same user turn they are replayed verbatim
 * and in order, each call followed by its `function_call_output`. Earlier turns are sent as compact
 * records (no reasoning), matching the `current_turn` reasoning context of the models used today.
 */

export interface OpenAiResponsesOptions {
  apiKey: string;
  model: string;
  reasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high';
  maxOutputTokens?: number;
  /** For tests / regional endpoints. Defaults to the SDK default. */
  baseURL?: string;
  /** Retries of the initial request only (safe: no side effects). */
  maxRetries?: number;
  requestTimeoutMs?: number;
  /**
   * Mark replayed assistant text as `phase: 'final_answer'`. OpenAI recommends resending `phase` for
   * GPT-5.3+ models; off by default so models without `phase` support keep the Phase 0 request shape.
   */
  assistantPhase?: boolean;
  /**
   * Output budget for requests that offer tools. Reasoning tokens count against `max_output_tokens`,
   * and a tool round also spends tokens on call arguments; a truncated round cannot act on its calls.
   */
  maxOutputTokensWithTools?: number;
}

const PROVIDER = 'openai';

export class OpenAiResponsesModel implements LanguageModel {
  readonly name = PROVIDER;
  private readonly client: OpenAI;
  private readonly options: OpenAiResponsesOptions;

  constructor(options: OpenAiResponsesOptions) {
    this.options = options;
    this.client = new OpenAI({
      apiKey: options.apiKey,
      ...(options.baseURL !== undefined ? { baseURL: options.baseURL } : {}),
      maxRetries: options.maxRetries ?? 1,
      timeout: options.requestTimeoutMs ?? 30_000,
    });
  }

  async *stream(request: LlmRequest, { signal }: { signal: AbortSignal }): AsyncGenerator<LlmEvent> {
    const o = this.options;
    const tools = request.tools ?? [];
    const maxOutputTokens = tools.length > 0 ? (o.maxOutputTokensWithTools ?? o.maxOutputTokens) : o.maxOutputTokens;
    try {
      const stream = await this.client.responses.create(
        {
          model: o.model,
          instructions: request.instructions,
          input: this.toInput(request.messages),
          stream: true,
          store: false,
          ...(maxOutputTokens !== undefined ? { max_output_tokens: maxOutputTokens } : {}),
          ...(o.reasoningEffort !== undefined ? { reasoning: { effort: o.reasoningEffort } } : {}),
          // One call per round keeps voice turns simple: act, report, then decide the next step.
          ...(tools.length > 0 ? { tools: tools.map(toFunctionTool), parallel_tool_calls: false } : {}),
          ...(tools.length > 0 && request.toolChoice !== undefined ? { tool_choice: request.toolChoice } : {}),
        },
        { signal },
      );
      // Completed items by position. The reasoning item's `encrypted_content` is final only in
      // `output_item.done` (it may be partial in `output_item.added`).
      const doneItems = new Map<number, ResponseOutputItem>();
      // A `final_answer` message right after a `commentary` message in the same response sometimes repeats
      // it word for word (observed live, plan step 8): it is held until complete and dropped if it does.
      const streamed = new Map<number, string>();
      let sawCommentary = false;
      let held: { index: number; text: string } | undefined;
      for await (const event of stream) {
        switch (event.type) {
          case 'response.output_item.added':
            if (event.item.type === 'message') {
              const phase = (event.item as { phase?: unknown }).phase;
              if (phase === 'final_answer' && sawCommentary) held = { index: event.output_index, text: '' };
              if (phase === 'commentary') sawCommentary = true;
            }
            break;
          case 'response.output_text.delta':
            if (event.delta === '') break;
            if (held?.index === event.output_index) {
              held.text += event.delta;
              break;
            }
            streamed.set(event.output_index, (streamed.get(event.output_index) ?? '') + event.delta);
            yield { type: 'text_delta', text: event.delta };
            break;
          case 'response.output_item.done':
            doneItems.set(event.output_index, event.item);
            if (held?.index === event.output_index) {
              const text = held.text;
              held = undefined;
              if (text.trim() !== '' && ![...streamed.values()].some((t) => t.trim() === text.trim())) yield { type: 'text_delta', text };
            }
            break;
          case 'response.completed': {
            const output = doneItems.size > 0 ? [...doneItems.entries()].sort(([a], [b]) => a - b).map(([, item]) => item) : event.response.output;
            yield this.completion(output);
            return;
          }
          case 'response.incomplete': // e.g. max_output_tokens: keep the text, never act on possibly truncated calls
            yield { type: 'completed' };
            return;
          case 'response.failed':
            throw new ProviderError(PROVIDER, kindFromCode(event.response.error?.code), event.response.error?.message ?? 'Response failed');
          case 'error':
            throw new ProviderError(PROVIDER, kindFromCode(event.code), event.message);
          default:
            break;
        }
      }
      if (signal.aborted) throw abortReason(signal);
      throw new ProviderError(PROVIDER, 'bad_response', 'Stream ended without a completion event');
    } catch (err) {
      throw normalizeError(err, signal);
    }
  }

  private completion(output: readonly ResponseOutputItem[]): LlmEvent {
    const toolCalls = output
      .filter((item) => item.type === 'function_call')
      .map((call) => ({ callId: call.call_id, name: call.name, arguments: call.arguments }));
    if (toolCalls.length === 0) return { type: 'completed' };
    return { type: 'completed', toolCalls, continuation: { provider: PROVIDER, model: this.options.model, items: output } };
  }

  /** Mujeeb's conversation → Responses API input items. */
  private toInput(items: readonly ConversationItem[]): ResponseInputItem[] {
    const input: ResponseInputItem[] = [];
    for (const item of items) {
      if (isChatMessage(item)) {
        input.push(
          item.role === 'assistant' && this.options.assistantPhase === true
            ? { role: 'assistant', content: item.text, phase: 'final_answer' }
            : { role: item.role, content: item.text },
        );
        continue;
      }
      const outputs = new Map(item.results.map((r) => [r.callId, r.output]));
      const continuation = item.continuation;
      if (continuation && continuation.provider === PROVIDER && continuation.model === this.options.model) {
        for (const raw of continuation.items) {
          const replayed = raw as { type?: unknown; call_id?: unknown; encrypted_content?: unknown };
          // Without its encrypted content a reasoning item cannot be replayed when nothing is stored server-side.
          if (replayed.type === 'reasoning' && (typeof replayed.encrypted_content !== 'string' || replayed.encrypted_content === '')) continue;
          // Never send a call without its result.
          if (replayed.type === 'function_call' && !outputs.has(String(replayed.call_id))) continue;
          input.push(raw as ResponseInputItem);
        }
      } else {
        // Earlier turn, or a different model: rebuild the calls from normalized data, without reasoning.
        for (const call of item.calls) {
          if (outputs.has(call.callId)) input.push({ type: 'function_call', call_id: call.callId, name: call.name, arguments: call.arguments });
        }
      }
      for (const call of item.calls) {
        const output = outputs.get(call.callId);
        if (output !== undefined) input.push({ type: 'function_call_output', call_id: call.callId, output });
      }
    }
    return input;
  }
}

function toFunctionTool(tool: ToolSpec): FunctionTool {
  return { type: 'function', name: tool.name, description: tool.description, parameters: tool.parameters, strict: true };
}

const QUOTA_CODES = new Set(['insufficient_quota', 'credit_balance_exhausted', 'billing_hard_limit_reached']);

function kindFromCode(code: string | null | undefined): ProviderErrorKind {
  if (code === 'rate_limit_exceeded') return 'rate_limit';
  if (code === 'server_error') return 'unavailable';
  if (code && QUOTA_CODES.has(code)) return 'quota';
  return 'bad_response';
}

function isQuotaError(err: { code?: string | null | undefined; type?: string | null | undefined }): boolean {
  return QUOTA_CODES.has(err.code ?? '') || QUOTA_CODES.has(err.type ?? '');
}

export function normalizeError(err: unknown, signal: AbortSignal): Error {
  if (err instanceof ProviderError) return err;
  if (err instanceof APIUserAbortError || signal.aborted) return abortReason(signal);
  if (err instanceof APIConnectionTimeoutError) return new ProviderError(PROVIDER, 'timeout', 'Request timed out', { cause: err });
  if (err instanceof APIConnectionError) return new ProviderError(PROVIDER, 'unavailable', 'Connection failed', { cause: err });
  // Billing errors can arrive as HTTP 429 or inside the SSE stream (no status): classify by type/code.
  if (err instanceof APIError && isQuotaError(err)) {
    return new ProviderError(PROVIDER, 'quota', 'OpenAI account has no remaining credits/quota', { cause: err });
  }
  if (err instanceof AuthenticationError || err instanceof PermissionDeniedError) {
    return new ProviderError(PROVIDER, 'auth', `Authentication failed (${err.status})`, { cause: err });
  }
  if (err instanceof RateLimitError) return new ProviderError(PROVIDER, 'rate_limit', 'Rate limited', { cause: err });
  if (err instanceof BadRequestError) return new ProviderError(PROVIDER, 'bad_request', err.message, { cause: err });
  if (err instanceof InternalServerError) return new ProviderError(PROVIDER, 'unavailable', `Server error (${err.status})`, { cause: err });
  if (err instanceof APIError) return new ProviderError(PROVIDER, kindFromCode(err.code ?? err.type), err.message, { cause: err });
  return new ProviderError(PROVIDER, 'unknown', err instanceof Error ? err.message : String(err), { cause: err });
}
