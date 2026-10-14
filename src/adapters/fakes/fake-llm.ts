import { sleep } from '../../core/async.js';
import type { ProviderError } from '../../core/errors.js';
import { type LanguageModel, type LlmEvent, type LlmRequest, type ToolCall, isChatMessage } from '../../ports/language-model.js';

/** One scripted model round: optional text, then optional tool calls (which end the round). */
export interface FakeRound {
  text?: string;
  toolCalls?: readonly { name: string; arguments: Record<string, unknown> | string }[];
}

export interface FakeLlmOptions {
  reply?: (request: LlmRequest) => string;
  /**
   * Scripted rounds for tool-calling tests (takes precedence over `reply`). `round` counts the tool
   * exchanges already in the current user turn: 0 for the first request of a turn.
   */
  script?: (request: LlmRequest, round: number) => FakeRound;
  firstTokenDelayMs?: number;
  tokenDelayMs?: number;
  /** Throw this error instead of answering. */
  failWith?: ProviderError;
  /** Never produce output (until aborted) — for timeout tests. */
  hang?: boolean;
}

export const FAKE_LLM_NAME = 'fake-llm';

export function defaultFakeReply(request: LlmRequest): string {
  const lastUser = [...request.messages].reverse().find((m) => isChatMessage(m) && m.role === 'user');
  return (
    `هذا رد تجريبي من مُجيب بدون مزود حقيقي. سمعتك تقول: ${lastUser && isChatMessage(lastUser) ? lastUser.text : ''}. ` +
    'أقدر أساعدك في الاستفسارات العامة عن العيادة التجريبية، ' +
    'وخليت هذا الرد أطول شوي عشان تقدر تجرب المقاطعة وأنا أتكلم.'
  );
}

/** Tool exchanges after the last user message: how many tool rounds this turn has already had. */
export function currentTurnRound(request: LlmRequest): number {
  let round = 0;
  for (let i = request.messages.length - 1; i >= 0; i -= 1) {
    const item = request.messages[i];
    if (item === undefined || (isChatMessage(item) && item.role === 'user')) break;
    if (!isChatMessage(item)) round += 1;
  }
  return round;
}

export class FakeLanguageModel implements LanguageModel {
  readonly name = FAKE_LLM_NAME;
  readonly calls: LlmRequest[] = [];
  aborted = 0;
  completed = 0;
  private readonly options: FakeLlmOptions;
  private callSequence = 0;

  constructor(options: FakeLlmOptions = {}) {
    this.options = options;
  }

  async *stream(request: LlmRequest, { signal }: { signal: AbortSignal }): AsyncGenerator<LlmEvent> {
    this.calls.push(request);
    let finished = false;
    try {
      await sleep(this.options.firstTokenDelayMs ?? 30, signal);
      if (this.options.failWith) throw this.options.failWith;
      if (this.options.hang) await sleep(60 * 60 * 1000, signal);
      const round = this.options.script ? this.options.script(request, currentTurnRound(request)) : { text: (this.options.reply ?? defaultFakeReply)(request) };
      const pieces = round.text?.match(/\S+\s*/g) ?? [];
      for (const piece of pieces) {
        yield { type: 'text_delta', text: piece };
        await sleep(this.options.tokenDelayMs ?? 5, signal);
      }
      finished = true;
      this.completed += 1;
      // Like a real model told `tool_choice: none`: answer in text only.
      const mayCall = request.toolChoice !== 'none';
      const toolCalls: ToolCall[] = (mayCall ? (round.toolCalls ?? []) : []).map((c) => ({
        callId: `call_${(this.callSequence += 1)}`,
        name: c.name,
        arguments: typeof c.arguments === 'string' ? c.arguments : JSON.stringify(c.arguments),
      }));
      if (toolCalls.length === 0) {
        yield { type: 'completed' };
      } else {
        // A stand-in for provider state, so callers can be tested for replaying it unchanged.
        const items = [{ type: 'fake_reasoning', round: currentTurnRound(request) }, ...toolCalls.map((c) => ({ type: 'fake_call', call_id: c.callId }))];
        yield { type: 'completed', toolCalls, continuation: { provider: FAKE_LLM_NAME, model: 'fake', items } };
      }
    } finally {
      if (!finished && signal.aborted) this.aborted += 1;
    }
  }
}
