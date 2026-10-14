import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { OpenAiResponsesModel } from '../../src/adapters/openai/responses-model.js';
import { CancelledError, ProviderError } from '../../src/core/errors.js';
import type { LlmEvent } from '../../src/ports/language-model.js';

/** Minimal stand-in for the Responses API streaming endpoint (Server-Sent Events). */
type Handler = (req: IncomingMessage, body: Record<string, unknown>, res: ServerResponse) => void;

let server: Server | undefined;
afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

async function startServer(handler: Handler): Promise<string> {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString()));
    req.on('end', () => handler(req, JSON.parse(raw || '{}') as Record<string, unknown>, res));
  });
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', () => resolve()));
  return `http://127.0.0.1:${(server?.address() as AddressInfo).port}/v1`;
}

function sse(res: ServerResponse, event: Record<string, unknown>): void {
  res.write(`event: ${String(event['type'])}\ndata: ${JSON.stringify(event)}\n\n`);
}

const delta = (text: string, seq: number) => ({ type: 'response.output_text.delta', delta: text, item_id: 'msg_1', output_index: 0, content_index: 0, sequence_number: seq, logprobs: [] });
const completed = (seq: number) => ({ type: 'response.completed', sequence_number: seq, response: { id: 'resp_1', object: 'response', status: 'completed', output: [] } });

function model(baseURL: string, extra: Partial<ConstructorParameters<typeof OpenAiResponsesModel>[0]> = {}) {
  return new OpenAiResponsesModel({ apiKey: 'sk-test', model: 'model-under-test', baseURL, maxRetries: 0, ...extra });
}

async function collect(iterable: AsyncIterable<LlmEvent>): Promise<LlmEvent[]> {
  const out: LlmEvent[] = [];
  for await (const e of iterable) out.push(e);
  return out;
}

describe('OpenAiResponsesModel', () => {
  it('streams deltas with store=false and Mujeeb-owned history', async () => {
    let seen: { body: Record<string, unknown>; auth: string | undefined } | undefined;
    const url = await startServer((req, body, res) => {
      seen = { body, auth: req.headers.authorization };
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      sse(res, delta('هلا ', 1));
      sse(res, delta('والله', 2));
      sse(res, completed(3));
      res.end();
    });
    const events = await collect(
      model(url, { reasoningEffort: 'low', maxOutputTokens: 300 }).stream(
        { instructions: 'be brief', messages: [{ role: 'user', text: 'مرحبا' }, { role: 'assistant', text: 'هلا' }, { role: 'user', text: 'كيفك' }] },
        { signal: new AbortController().signal },
      ),
    );
    expect(events).toEqual([{ type: 'text_delta', text: 'هلا ' }, { type: 'text_delta', text: 'والله' }, { type: 'completed' }]);
    expect(seen?.auth).toBe('Bearer sk-test');
    expect(seen?.body).toMatchObject({
      model: 'model-under-test',
      instructions: 'be brief',
      stream: true,
      store: false,
      max_output_tokens: 300,
      reasoning: { effort: 'low' },
      input: [
        { role: 'user', content: 'مرحبا' },
        { role: 'assistant', content: 'هلا' },
        { role: 'user', content: 'كيفك' },
      ],
    });
    expect(seen?.body).not.toHaveProperty('previous_response_id');
  });

  it.each([
    [401, 'auth'],
    [429, 'rate_limit'],
    [500, 'unavailable'],
    [400, 'bad_request'],
  ])('maps HTTP %i to %s', async (status, kind) => {
    const url = await startServer((_req, _body, res) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'nope', type: 'x', code: null } }));
    });
    const error = await collect(model(url).stream({ instructions: '', messages: [] }, { signal: new AbortController().signal })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ provider: 'openai', kind });
  });

  it('classifies an exhausted credit balance as non-retryable quota (HTTP 429 and in-stream)', async () => {
    const billing = { message: 'You have no credits remaining.', type: 'insufficient_quota', param: null, code: 'credit_balance_exhausted' };
    const signal = new AbortController().signal;
    let url = await startServer((_req, _body, res) => {
      res.writeHead(429, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: billing }));
    });
    let error = await collect(model(url).stream({ instructions: '', messages: [] }, { signal })).catch((e: unknown) => e);
    expect(error).toMatchObject({ kind: 'quota', retryable: false });

    await new Promise<void>((resolve) => server?.close(() => resolve()));
    url = await startServer((_req, _body, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`event: error\ndata: ${JSON.stringify({ error: billing })}\n\n`);
      res.end();
    });
    error = await collect(model(url).stream({ instructions: '', messages: [] }, { signal })).catch((e: unknown) => e);
    expect(error).toMatchObject({ kind: 'quota', retryable: false });
  });

  it('surfaces response.failed as a ProviderError', async () => {
    const url = await startServer((_req, _body, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      sse(res, { type: 'response.failed', sequence_number: 1, response: { id: 'r', status: 'failed', error: { code: 'server_error', message: 'boom' } } });
      res.end();
    });
    const error = await collect(model(url).stream({ instructions: '', messages: [] }, { signal: new AbortController().signal })).catch((e: unknown) => e);
    expect(error).toMatchObject({ kind: 'unavailable', message: 'boom' });
  });

  it('aborts an in-flight stream promptly and closes the HTTP request', async () => {
    let requestClosed = false;
    const url = await startServer((req, _body, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      sse(res, delta('بداية ', 1)); // then never finishes
      req.socket.on('close', () => (requestClosed = true));
    });
    const controller = new AbortController();
    const seen: LlmEvent[] = [];
    const run = (async () => {
      for await (const e of model(url).stream({ instructions: '', messages: [] }, { signal: controller.signal })) {
        seen.push(e);
        controller.abort(new CancelledError('barge_in'));
      }
    })();
    const error = await run.catch((e: unknown) => e);
    expect(seen).toEqual([{ type: 'text_delta', text: 'بداية ' }]);
    expect(error).toBeInstanceOf(CancelledError);
    await new Promise((r) => setTimeout(r, 100));
    expect(requestClosed).toBe(true);
  });
});
