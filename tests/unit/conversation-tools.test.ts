import { describe, expect, it } from 'vitest';
import { FakeLanguageModel, currentTurnRound } from '../../src/adapters/fakes/fake-llm.js';
import { Conversation } from '../../src/agent/conversation.js';
import { type LlmEvent, type ToolExchange, isChatMessage } from '../../src/ports/language-model.js';

const exchange = (id: string, withContinuation = false): ToolExchange => ({
  type: 'tool_exchange',
  calls: [{ callId: id, name: 'search_clinic_directory', arguments: '{}' }],
  results: [{ callId: id, output: '{"status":"ok"}' }],
  ...(withContinuation ? { continuation: { provider: 'p', model: 'm', items: [{ type: 'reasoning', id }] } } : {}),
});

async function collect(iterable: AsyncIterable<LlmEvent>): Promise<LlmEvent[]> {
  const out: LlmEvent[] = [];
  for await (const e of iterable) out.push(e);
  return out;
}

describe('Conversation with tool rounds', () => {
  it('builds a request: history, pending user, then this turn’s rounds with their continuation; context and tools only when given', () => {
    const c = new Conversation({ instructions: 'base', maxTurns: 5 });
    c.commitTurn({ user: 'أول', assistant: 'رد' });
    const round = exchange('call_1', true);
    const request = c.request('ثاني', { currentTurn: [round], tools: [{ name: 't', description: 'd', parameters: {} }], context: 'الآن: الأحد' });
    expect(request.instructions).toBe('base\n\nالآن: الأحد');
    expect(request.messages).toEqual([{ role: 'user', text: 'أول' }, { role: 'assistant', text: 'رد' }, { role: 'user', text: 'ثاني' }, round]);
    expect(request.tools).toHaveLength(1);
    expect(c.request('x', { tools: [] })).not.toHaveProperty('tools');
    expect(c.request('x').instructions).toBe('base');
  });

  it('commits a turn compactly: provider continuation dropped, transcript without tool items', () => {
    const c = new Conversation({ instructions: 'i', maxTurns: 5 });
    c.commitTurn({ user: 'أبي جلدية', exchanges: [exchange('call_1', true)], assistant: 'عندنا الدكتورة سارة', interrupted: true });
    expect(c.entries()).toEqual([
      { role: 'user', text: 'أبي جلدية' },
      { type: 'tool_exchange', calls: exchange('call_1').calls, results: exchange('call_1').results },
      { role: 'assistant', text: 'عندنا الدكتورة سارة [قاطعه المتصل هنا]' },
    ]);
    expect(c.snapshot()).toEqual([
      { role: 'user', text: 'أبي جلدية' },
      { role: 'assistant', text: 'عندنا الدكتورة سارة [قاطعه المتصل هنا]' },
    ]);
  });

  it('trims whole turns, so no tool round outlives its user message', () => {
    const c = new Conversation({ instructions: 'i', maxTurns: 2 });
    c.addAssistant('هلا والله'); // greeting
    for (const n of [1, 2, 3]) c.commitTurn({ user: `طلب ${n}`, exchanges: [exchange(`call_${n}`)], assistant: `رد ${n}` });
    const entries = c.entries();
    expect(entries[0]).toEqual({ role: 'user', text: 'طلب 2' });
    expect(entries).toHaveLength(6);
    expect(entries.filter((e): e is ToolExchange => !isChatMessage(e)).map((e) => e.calls[0]?.callId)).toEqual(['call_2', 'call_3']);
  });

  it('keeps text-only history as before', () => {
    const c = new Conversation({ instructions: 'i', maxTurns: 2 });
    c.addAssistant('هلا');
    c.addUser('س1');
    c.addAssistant('ج1');
    expect(c.snapshot()).toEqual([
      { role: 'assistant', text: 'هلا' },
      { role: 'user', text: 'س1' },
      { role: 'assistant', text: 'ج1' },
    ]);
    expect(c.request('س2').messages.at(-1)).toEqual({ role: 'user', text: 'س2' });
  });

  it('refuses a tool round that leaves a call without its result', () => {
    const c = new Conversation({ instructions: 'i', maxTurns: 2 });
    const broken: ToolExchange = { type: 'tool_exchange', calls: [{ callId: 'a', name: 't', arguments: '{}' }, { callId: 'b', name: 't', arguments: '{}' }], results: [{ callId: 'a', output: '{}' }] };
    expect(() => c.addToolExchange(broken)).toThrow(/missing: b/);
    expect(() => c.request('x', { currentTurn: [broken] })).toThrow(/missing: b/);
  });
});

describe('FakeLanguageModel script', () => {
  it('plays scripted rounds: text, then tool calls with a continuation; the round count follows this turn’s exchanges', async () => {
    const llm = new FakeLanguageModel({
      firstTokenDelayMs: 0,
      tokenDelayMs: 0,
      script: (_request, round) => (round === 0 ? { text: 'لحظة ', toolCalls: [{ name: 'search_clinic_directory', arguments: { query: 'جلدية' } }] } : { text: 'تمام' }),
    });
    const c = new Conversation({ instructions: 'i', maxTurns: 5 });
    const first = await collect(llm.stream(c.request('أبي جلدية'), { signal: new AbortController().signal }));
    expect(first[0]).toEqual({ type: 'text_delta', text: 'لحظة ' });
    const done = first.at(-1);
    if (done?.type !== 'completed' || !done.toolCalls?.[0]) throw new Error('expected a tool call');
    expect(done.toolCalls[0]).toEqual({ callId: 'call_1', name: 'search_clinic_directory', arguments: '{"query":"جلدية"}' });
    expect(done.continuation).toMatchObject({ provider: 'fake-llm', items: [{ type: 'fake_reasoning', round: 0 }, { type: 'fake_call', call_id: 'call_1' }] });

    const round: ToolExchange = { type: 'tool_exchange', calls: done.toolCalls, results: [{ callId: 'call_1', output: '{}' }], continuation: done.continuation! };
    const request = c.request('أبي جلدية', { currentTurn: [round] });
    expect(currentTurnRound(request)).toBe(1);
    const second = await collect(llm.stream(request, { signal: new AbortController().signal }));
    expect(second).toEqual([{ type: 'text_delta', text: 'تمام' }, { type: 'completed' }]);
  });

  it('still answers text-only requests with the default reply', async () => {
    const llm = new FakeLanguageModel({ firstTokenDelayMs: 0, tokenDelayMs: 0 });
    const events = await collect(llm.stream(new Conversation({ instructions: 'i', maxTurns: 2 }).request('مرحبا'), { signal: new AbortController().signal }));
    expect(events.at(-1)).toEqual({ type: 'completed' });
    expect(events.filter((e) => e.type === 'text_delta').map((e) => (e.type === 'text_delta' ? e.text : '')).join('')).toContain('سمعتك تقول: مرحبا');
  });
});
