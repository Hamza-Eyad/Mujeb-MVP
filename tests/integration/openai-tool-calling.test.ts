import { readFileSync } from 'node:fs';
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { MemorySchedulingSystem } from '../../src/adapters/fakes/memory-scheduling.js';
import { OpenAiResponsesModel } from '../../src/adapters/openai/responses-model.js';
import { Conversation } from '../../src/agent/conversation.js';
import { AppointmentTools } from '../../src/agent/tools/appointment-tools.js';
import { toolParametersJsonSchema } from '../../src/contracts/appointment-tools.js';
import { parseSchedulingDataset } from '../../src/contracts/scheduling-dataset.js';
import { CancelledError, ProviderError } from '../../src/core/errors.js';
import { silentLogger } from '../../src/core/logger.js';
import type { LlmEvent, LlmRequest, ModelContinuation, ToolExchange, ToolSpec } from '../../src/ports/language-model.js';

/**
 * Function calling over a local stand-in for the Responses API streaming endpoint (no network, no
 * paid calls). Event and item shapes follow the Responses API; what matters is what Mujeeb sends back.
 */

type Body = Record<string, unknown>;
type Handler = (body: Body, res: ServerResponse, req: IncomingMessage) => void;

let server: Server | undefined;
afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

/** Serves `handlers[i]` for the i-th request and records every request body. */
async function startServer(handlers: Handler[]): Promise<{ url: string; bodies: Body[] }> {
  const bodies: Body[] = [];
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString()));
    req.on('end', () => {
      const body = JSON.parse(raw || '{}') as Body;
      bodies.push(body);
      const handler = handlers[bodies.length - 1] ?? handlers[handlers.length - 1];
      handler?.(body, res, req);
    });
  });
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', () => resolve()));
  return { url: `http://127.0.0.1:${(server?.address() as AddressInfo).port}/v1`, bodies };
}

let seq = 0;
function sse(res: ServerResponse, event: Record<string, unknown>): void {
  res.write(`event: ${String(event['type'])}\ndata: ${JSON.stringify({ sequence_number: (seq += 1), ...event })}\n\n`);
}

const reasoning = (id: string, encrypted: string | null = `enc-${id}`) => ({ type: 'reasoning', id, summary: [], encrypted_content: encrypted, status: 'completed' });
const message = (id: string, text: string, phase: 'commentary' | 'final_answer') => ({
  type: 'message',
  id,
  role: 'assistant',
  status: 'completed',
  phase,
  content: [{ type: 'output_text', text, annotations: [] }],
});
const functionCall = (id: string, callId: string, name: string, args: Record<string, unknown>) => ({
  type: 'function_call',
  id,
  call_id: callId,
  name,
  arguments: JSON.stringify(args),
  status: 'completed',
});

/** Streams a full round: text deltas for message items, `output_item.done` for every item, then completion. */
function round(items: Record<string, unknown>[], options?: { end?: 'completed' | 'incomplete'; doneEvents?: boolean }): Handler {
  return (_body, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    items.forEach((item, index) => {
      if (item['type'] === 'message') {
        const text = ((item['content'] as { text: string }[])[0] ?? { text: '' }).text;
        sse(res, { type: 'response.output_text.delta', delta: text, item_id: item['id'], output_index: index, content_index: 0, logprobs: [] });
      }
      if (options?.doneEvents !== false) sse(res, { type: 'response.output_item.done', output_index: index, item });
    });
    const end = options?.end ?? 'completed';
    sse(res, { type: `response.${end}`, response: { id: 'resp', object: 'response', status: end, output: items } });
    res.end();
  };
}

function model(url: string, extra: Partial<ConstructorParameters<typeof OpenAiResponsesModel>[0]> = {}) {
  return new OpenAiResponsesModel({ apiKey: 'sk-test', model: 'model-a', baseURL: url, maxRetries: 0, ...extra });
}

async function collect(iterable: AsyncIterable<LlmEvent>): Promise<LlmEvent[]> {
  const out: LlmEvent[] = [];
  for await (const e of iterable) out.push(e);
  return out;
}

const signal = () => new AbortController().signal;
const completedOf = (events: LlmEvent[]) => {
  const last = events.at(-1);
  if (last?.type !== 'completed') throw new Error('no completion');
  return last;
};
const TOOLS: ToolSpec[] = [
  { name: 'search_clinic_directory', description: 'Search the directory', parameters: toolParametersJsonSchema('search_clinic_directory') },
  { name: 'propose_booking', description: 'Prepare a booking', parameters: toolParametersJsonSchema('propose_booking') },
];

describe('OpenAiResponsesModel — repeated answers', () => {
  /** A round as the live API streams it, `output_item.added` included. */
  const liveRound = (items: Record<string, unknown>[]): Handler => (_body, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    items.forEach((item, index) => {
      sse(res, { type: 'response.output_item.added', output_index: index, item: { ...item, ...(item['type'] === 'message' ? { content: [] } : {}) } });
      if (item['type'] === 'message') {
        const text = ((item['content'] as { text: string }[])[0] ?? { text: '' }).text;
        for (const piece of text.match(/\S+\s*/g) ?? []) sse(res, { type: 'response.output_text.delta', delta: piece, item_id: item['id'], output_index: index, content_index: 0, logprobs: [] });
      }
      sse(res, { type: 'response.output_item.done', output_index: index, item });
    });
    sse(res, { type: 'response.completed', response: { id: 'resp', object: 'response', status: 'completed', output: items } });
    res.end();
  };
  const textOf = (events: LlmEvent[]) => events.map((e) => (e.type === 'text_delta' ? e.text : '')).join('');

  it('says a final answer once when the model repeats its commentary word for word (observed live)', async () => {
    const answer = 'أقدر أحجز لك مع الدّكتورة سارة الغامدي اليوم أربع مساءً، أيهم تبي؟';
    const { url } = await startServer([liveRound([message('m1', answer, 'commentary'), message('m2', answer, 'final_answer')])]);
    expect(textOf(await collect(model(url).stream({ instructions: 'i', messages: [{ role: 'user', text: 'x' }], tools: TOOLS }, { signal: signal() })))).toBe(answer);
  });

  it('keeps a final answer that differs from the commentary, and streams answers without commentary as before', async () => {
    const { url } = await startServer([
      liveRound([message('m1', 'لحظة أشيك لك. ', 'commentary'), message('m2', 'عندي لك أربع مساءً.', 'final_answer')]),
      liveRound([message('m3', 'عندي لك أربع مساءً.', 'final_answer')]),
    ]);
    const llm = model(url);
    const request = { instructions: 'i', messages: [{ role: 'user' as const, text: 'x' }], tools: TOOLS };
    expect(textOf(await collect(llm.stream(request, { signal: signal() })))).toBe('لحظة أشيك لك. عندي لك أربع مساءً.');
    const plain = await collect(llm.stream(request, { signal: signal() }));
    expect(plain.filter((e) => e.type === 'text_delta').length).toBeGreaterThan(1); // streamed piece by piece, not held
    expect(textOf(plain)).toBe('عندي لك أربع مساءً.');
  });
});

describe('OpenAiResponsesModel — function calling', () => {
  it('offers tools as strict functions, one call per round, and keeps text-only requests unchanged', async () => {
    const { url, bodies } = await startServer([round([message('m1', 'هلا', 'final_answer')])]);
    const llm = model(url);
    await collect(llm.stream({ instructions: 'i', messages: [{ role: 'user', text: 'مرحبا' }], tools: TOOLS }, { signal: signal() }));
    expect(bodies[0]).toMatchObject({ store: false, parallel_tool_calls: false });
    expect(bodies[0]?.['tools']).toEqual(TOOLS.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.parameters, strict: true })));
    const params = (bodies[0]?.['tools'] as { parameters: { additionalProperties: boolean; required: string[]; properties: Record<string, unknown> } }[])[0]?.parameters;
    expect(params?.additionalProperties).toBe(false);
    expect([...(params?.required ?? [])].sort()).toEqual(Object.keys(params?.properties ?? {}).sort());

    await collect(llm.stream({ instructions: 'i', messages: [{ role: 'user', text: 'مرحبا' }] }, { signal: signal() }));
    expect(bodies[1]).not.toHaveProperty('tools');
    expect(bodies[1]).not.toHaveProperty('parallel_tool_calls');
    expect(bodies[1]).not.toHaveProperty('include');
    expect(bodies[1]).not.toHaveProperty('previous_response_id');
  });

  it('streams the preamble, then returns the call with the round as an opaque continuation', async () => {
    const items = [
      reasoning('rs_1'),
      message('msg_1', 'لحظة أشيك لك. ', 'commentary'),
      functionCall('fc_1', 'call_1', 'search_clinic_directory', { query: 'جلدية', kind: 'service', service_ref: null }),
    ];
    const { url } = await startServer([round(items)]);
    const events = await collect(model(url).stream({ instructions: 'i', messages: [{ role: 'user', text: 'أبي جلدية' }], tools: TOOLS }, { signal: signal() }));
    expect(events[0]).toEqual({ type: 'text_delta', text: 'لحظة أشيك لك. ' });
    expect(completedOf(events)).toEqual({
      type: 'completed',
      toolCalls: [{ callId: 'call_1', name: 'search_clinic_directory', arguments: '{"query":"جلدية","kind":"service","service_ref":null}' }],
      continuation: { provider: 'openai', model: 'model-a', items },
    });
  });

  it('takes items from response.completed when no output_item.done events arrive', async () => {
    const items = [reasoning('rs_1'), functionCall('fc_1', 'call_1', 'search_clinic_directory', { query: 'x', kind: 'any', service_ref: null })];
    const { url } = await startServer([round(items, { doneEvents: false })]);
    const done = completedOf(await collect(model(url).stream({ instructions: 'i', messages: [], tools: TOOLS }, { signal: signal() })));
    expect(done.continuation?.items).toEqual(items);
    expect(done.toolCalls).toHaveLength(1);
  });

  it('prefers the items from output_item.done (final encrypted reasoning) over the completion summary', async () => {
    const call = functionCall('fc_1', 'call_1', 'search_clinic_directory', { query: 'x', kind: 'any', service_ref: null });
    const { url } = await startServer([
      (_b, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        sse(res, { type: 'response.output_item.done', output_index: 0, item: reasoning('rs_1', 'full-encrypted') });
        sse(res, { type: 'response.output_item.done', output_index: 1, item: call });
        sse(res, { type: 'response.completed', response: { id: 'r', status: 'completed', output: [reasoning('rs_1', 'partial'), call] } });
        res.end();
      },
    ]);
    const done = completedOf(await collect(model(url).stream({ instructions: 'i', messages: [], tools: TOOLS }, { signal: signal() })));
    expect(done.continuation?.items[0]).toMatchObject({ encrypted_content: 'full-encrypted' });
  });

  it('never acts on calls from a truncated (incomplete) response', async () => {
    const { url } = await startServer([round([functionCall('fc_1', 'call_1', 'propose_booking', { patient_ref: 'P1', slot_ref: 'S1' })], { end: 'incomplete' })]);
    const events = await collect(model(url).stream({ instructions: 'i', messages: [], tools: TOOLS }, { signal: signal() }));
    expect(events).toEqual([{ type: 'completed' }]);
  });

  it('replays every item of earlier rounds in this turn verbatim and in order, each call followed by its output', async () => {
    const round1 = [reasoning('rs_1'), message('msg_1', 'لحظة. ', 'commentary'), functionCall('fc_1', 'call_1', 'search_clinic_directory', { query: 'جلدية', kind: 'service', service_ref: null })];
    const round2 = [reasoning('rs_2'), functionCall('fc_2', 'call_2', 'propose_booking', { patient_ref: 'P1', slot_ref: 'S1' })];
    const { url, bodies } = await startServer([round(round1), round(round2), round([message('msg_3', 'تمام', 'final_answer')])]);
    const llm = model(url);
    const conversation = new Conversation({ instructions: 'i', maxTurns: 10 });
    conversation.commitTurn({ user: 'السلام عليكم', assistant: 'وعليكم السلام' });

    const user = 'أبي موعد جلدية';
    const exchanges: ToolExchange[] = [];
    for (const outputJson of ['{"status":"ok","n":1}', '{"status":"confirmation_required"}']) {
      const done = completedOf(await collect(llm.stream(conversation.request(user, { currentTurn: exchanges, tools: TOOLS }), { signal: signal() })));
      const calls = done.toolCalls ?? [];
      exchanges.push({
        type: 'tool_exchange',
        calls,
        results: calls.map((c) => ({ callId: c.callId, output: outputJson })),
        ...(done.continuation ? { continuation: done.continuation } : {}),
      });
    }
    await collect(llm.stream(conversation.request(user, { currentTurn: exchanges, tools: TOOLS }), { signal: signal() }));

    expect(bodies[2]?.['input']).toEqual([
      { role: 'user', content: 'السلام عليكم' },
      { role: 'assistant', content: 'وعليكم السلام' },
      { role: 'user', content: 'أبي موعد جلدية' },
      ...round1,
      { type: 'function_call_output', call_id: 'call_1', output: '{"status":"ok","n":1}' },
      ...round2,
      { type: 'function_call_output', call_id: 'call_2', output: '{"status":"confirmation_required"}' },
    ]);
    expect(bodies[2]).toMatchObject({ store: false });
    expect(bodies[2]).not.toHaveProperty('previous_response_id');
  });

  it('drops what cannot be replayed safely: reasoning without encrypted content, calls without results', async () => {
    const { url, bodies } = await startServer([round([message('m', 'ok', 'final_answer')])]);
    const continuation: ModelContinuation = {
      provider: 'openai',
      model: 'model-a',
      items: [reasoning('rs_x', null), functionCall('fc_1', 'call_1', 'search_clinic_directory', {}), functionCall('fc_9', 'call_9', 'propose_booking', {})],
    };
    const exchange: ToolExchange = {
      type: 'tool_exchange',
      calls: [{ callId: 'call_1', name: 'search_clinic_directory', arguments: '{}' }],
      results: [{ callId: 'call_1', output: '{}' }],
      continuation,
    };
    await collect(model(url).stream({ instructions: 'i', messages: [{ role: 'user', text: 'x' }, exchange], tools: TOOLS }, { signal: signal() }));
    expect(bodies[0]?.['input']).toEqual([
      { role: 'user', content: 'x' },
      functionCall('fc_1', 'call_1', 'search_clinic_directory', {}),
      { type: 'function_call_output', call_id: 'call_1', output: '{}' },
    ]);
  });

  it('rebuilds calls without reasoning for a different model or provider', async () => {
    const { url, bodies } = await startServer([round([message('m', 'ok', 'final_answer')])]);
    const exchange: ToolExchange = {
      type: 'tool_exchange',
      calls: [{ callId: 'call_1', name: 'search_clinic_directory', arguments: '{"query":"x"}' }],
      results: [{ callId: 'call_1', output: '{"status":"ok"}' }],
      continuation: { provider: 'openai', model: 'model-old', items: [reasoning('rs_1'), functionCall('fc_1', 'call_1', 'search_clinic_directory', { query: 'x' })] },
    };
    await collect(model(url).stream({ instructions: 'i', messages: [{ role: 'user', text: 'x' }, exchange], tools: TOOLS }, { signal: signal() }));
    expect(bodies[0]?.['input']).toEqual([
      { role: 'user', content: 'x' },
      { type: 'function_call', call_id: 'call_1', name: 'search_clinic_directory', arguments: '{"query":"x"}' },
      { type: 'function_call_output', call_id: 'call_1', output: '{"status":"ok"}' },
    ]);
  });

  it('sends earlier turns compactly, with phase on assistant text only when enabled', async () => {
    const { url, bodies } = await startServer([round([message('m', 'ok', 'final_answer')])]);
    const conversation = new Conversation({ instructions: 'i', maxTurns: 10 });
    conversation.commitTurn({
      user: 'أبي جلدية',
      exchanges: [
        {
          type: 'tool_exchange',
          calls: [{ callId: 'call_1', name: 'search_clinic_directory', arguments: '{}' }],
          results: [{ callId: 'call_1', output: '{"status":"ok"}' }],
          continuation: { provider: 'openai', model: 'model-a', items: [reasoning('rs_1'), functionCall('fc_1', 'call_1', 'search_clinic_directory', {})] },
        },
      ],
      assistant: 'عندنا الدكتورة سارة',
    });
    const request: LlmRequest = conversation.request('طيب متى؟', { tools: TOOLS });
    await collect(model(url, { assistantPhase: true }).stream(request, { signal: signal() }));
    expect(bodies[0]?.['input']).toEqual([
      { role: 'user', content: 'أبي جلدية' },
      { type: 'function_call', call_id: 'call_1', name: 'search_clinic_directory', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call_1', output: '{"status":"ok"}' },
      { role: 'assistant', content: 'عندنا الدكتورة سارة', phase: 'final_answer' },
      { role: 'user', content: 'طيب متى؟' },
    ]);
  });

  it('surfaces errors in a tool round as ProviderError and aborts promptly', async () => {
    const { url } = await startServer([
      (_b, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        sse(res, { type: 'response.output_item.done', output_index: 0, item: reasoning('rs_1') });
        sse(res, { type: 'response.failed', response: { id: 'r', status: 'failed', output: [], error: { code: 'server_error', message: 'boom' } } });
        res.end();
      },
      (_b, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        sse(res, { type: 'response.output_text.delta', delta: 'لحظة ', item_id: 'm', output_index: 0, content_index: 0, logprobs: [] });
      },
    ]);
    const llm = model(url);
    const failed = await collect(llm.stream({ instructions: 'i', messages: [], tools: TOOLS }, { signal: signal() })).catch((e: unknown) => e);
    expect(failed).toBeInstanceOf(ProviderError);
    expect(failed).toMatchObject({ kind: 'unavailable' });

    const controller = new AbortController();
    const run = (async () => {
      for await (const e of llm.stream({ instructions: 'i', messages: [], tools: TOOLS }, { signal: controller.signal })) {
        if (e.type === 'text_delta') controller.abort(new CancelledError('barge_in'));
      }
    })();
    await expect(run).rejects.toBeInstanceOf(CancelledError);
  });
});

describe('OpenAiResponsesModel — Step 4 request settings', () => {
  it('uses the tool output budget and tool_choice only when tools are offered', async () => {
    const { url, bodies } = await startServer([round([message('m', 'ok', 'final_answer')])]);
    const llm = model(url, { maxOutputTokens: 300, maxOutputTokensWithTools: 1024 });
    await collect(llm.stream({ instructions: 'i', messages: [], tools: TOOLS, toolChoice: 'none' }, { signal: signal() }));
    await collect(llm.stream({ instructions: 'i', messages: [], toolChoice: 'none' }, { signal: signal() }));
    expect(bodies[0]).toMatchObject({ max_output_tokens: 1024, tool_choice: 'none' });
    expect(bodies[1]).toMatchObject({ max_output_tokens: 300 });
    expect(bodies[1]).not.toHaveProperty('tool_choice');
  });

  it('with assistantPhase on, keeps the original phase of replayed items and marks only earlier assistant text', async () => {
    const { url, bodies } = await startServer([round([message('m', 'ok', 'final_answer')])]);
    const commentary = message('msg_1', 'لحظة. ', 'commentary');
    const call = functionCall('fc_1', 'call_1', 'search_clinic_directory', {});
    const current: ToolExchange = {
      type: 'tool_exchange',
      calls: [{ callId: 'call_1', name: 'search_clinic_directory', arguments: '{}' }],
      results: [{ callId: 'call_1', output: '{}' }],
      continuation: { provider: 'openai', model: 'model-a', items: [reasoning('rs_1'), commentary, call] },
    };
    const messages = [{ role: 'user' as const, text: 'قبل' }, { role: 'assistant' as const, text: 'رد سابق' }, { role: 'user' as const, text: 'الآن' }, current];
    await collect(model(url, { assistantPhase: true }).stream({ instructions: 'i', messages, tools: TOOLS }, { signal: signal() }));
    const input = bodies[0]?.['input'] as Record<string, unknown>[];
    expect(input[0]).toEqual({ role: 'user', content: 'قبل' });
    expect(input[1]).toEqual({ role: 'assistant', content: 'رد سابق', phase: 'final_answer' });
    expect(input[2]).toEqual({ role: 'user', content: 'الآن' });
    expect(input[4]).toEqual(commentary); // phase "commentary" preserved verbatim
  });
});

describe('multi-round tool use with real appointment tools (local model stand-in)', () => {
  it('runs model → tool → model rounds, then keeps the turn compact for the next one', async () => {
    const dataset = parseSchedulingDataset(JSON.parse(readFileSync('config/test-data/demo-clinic.dataset.json', 'utf8')));
    const now = () => new Date('2026-10-11T05:00:00Z');
    const tools = new AppointmentTools({
      scheduling: new MemorySchedulingSystem({ tenantId: 'demo', dataset, now }),
      tenant: { tenantId: 'demo', agentId: 'demo-clinic' },
      sessionId: 'ses_llm',
      timeZone: 'Asia/Riyadh',
      log: silentLogger,
      verificationPolicy: 'dev-identifier-dob',
      now,
    });
    const specs: ToolSpec[] = tools.definitions();
    const { url, bodies } = await startServer([
      round([reasoning('rs_1'), functionCall('fc_1', 'call_1', 'search_clinic_directory', { query: 'جلدية', kind: 'service', service_ref: null })]),
      round([reasoning('rs_2'), message('msg_2', 'عندنا قسم الجلدية. ', 'final_answer')]),
      round([message('msg_3', 'أبشر', 'final_answer')]),
    ]);
    const llm = model(url);
    const conversation = new Conversation({ instructions: 'i', maxTurns: 10 });
    const user = 'عندكم جلدية؟';
    const exchanges: ToolExchange[] = [];
    let spoken = '';
    for (let i = 0; i < 4; i += 1) {
      const events = await collect(llm.stream(conversation.request(user, { currentTurn: exchanges, tools: specs, context: 'الآن: الأحد 2026-10-11 08:00' }), { signal: signal() }));
      for (const e of events) if (e.type === 'text_delta') spoken += e.text;
      const done = completedOf(events);
      if (!done.toolCalls?.length) break;
      const results = [];
      for (const call of done.toolCalls) {
        const { output } = await tools.execute(call.name, call.arguments, { userTurn: 1, callerUtterance: user, turnId: 't1', signal: signal() });
        results.push({ callId: call.callId, output: JSON.stringify(output) });
      }
      exchanges.push({ type: 'tool_exchange', calls: done.toolCalls, results, ...(done.continuation ? { continuation: done.continuation } : {}) });
    }
    expect(bodies).toHaveLength(2);
    expect(spoken).toBe('عندنا قسم الجلدية. ');
    expect(bodies[0]?.['instructions']).toBe('i\n\nالآن: الأحد 2026-10-11 08:00');
    const secondInput = bodies[1]?.['input'] as Record<string, unknown>[];
    const output = secondInput.find((item) => item['type'] === 'function_call_output');
    expect(JSON.parse(String(output?.['output']))).toMatchObject({ status: 'ok', results: [{ ref: 'V1', kind: 'service', name: 'الجلدية' }] });
    expect(secondInput.find((item) => item['type'] === 'reasoning')).toMatchObject({ id: 'rs_1', encrypted_content: 'enc-rs_1' });

    conversation.commitTurn({ user, exchanges, assistant: spoken });
    await collect(llm.stream(conversation.request('طيب أبي موعد', { tools: specs }), { signal: signal() }));
    const thirdInput = bodies[2]?.['input'] as Record<string, unknown>[];
    expect(thirdInput.map((item) => item['type'] ?? item['role'])).toEqual(['user', 'function_call', 'function_call_output', 'assistant', 'user']);
    expect(JSON.stringify(thirdInput)).not.toContain('enc-rs_1');
  });
});
