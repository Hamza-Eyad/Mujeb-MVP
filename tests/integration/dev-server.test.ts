import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { FakeLanguageModel } from '../../src/adapters/fakes/fake-llm.js';
import { FakeSpeechToText } from '../../src/adapters/fakes/fake-stt.js';
import { FakeTextToSpeech } from '../../src/adapters/fakes/fake-tts.js';
import { type DevServer, startDevServer } from '../../src/app/dev-server.js';
import { silentLogger } from '../../src/core/logger.js';
import { MemoryTurnSink } from '../../src/observability/turn-metrics.js';
import { TEST_CONFIG, frame, waitFor } from '../support/session-harness.js';

let server: DevServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function start(llm = new FakeLanguageModel()): Promise<DevServer> {
  server = await startDevServer({
    host: '127.0.0.1',
    port: 0,
    staticDir: 'web/dev-client',
    maxSessions: 2,
    profile: { tenantId: 'demo', agentId: 'demo-clinic', displayName: 'Demo', languageCode: 'ar', instructions: 'x', historyMaxTurns: 6 },
    providers: { stt: new FakeSpeechToText({ mode: 'energy' }), llm, tts: new FakeTextToSpeech({ msPerChar: 25, realtimeFactor: 0.2 }) },
    sessionConfig: TEST_CONFIG,
    metrics: new MemoryTurnSink(),
    log: silentLogger,
    displayConfig: { llm: { provider: 'fake', model: 'm' }, openai_key_present: false },
  });
  return server;
}

interface Received {
  json: Array<Record<string, unknown>>;
  audio: Array<{ epoch: number; bytes: number; index: number }>;
  order: number;
}

/** A scripted browser: acks marks as if played instantly, reports playback start and clear. */
function connect(url: string): Promise<{ ws: WebSocket; rx: Received }> {
  const ws = new WebSocket(`${url.replace('http', 'ws')}/ws`, { origin: url });
  const rx: Received = { json: [], audio: [], order: 0 };
  const started = new Set<number>();
  ws.on('message', (data, isBinary) => {
    rx.order += 1;
    const buf = data as Buffer;
    if (isBinary) {
      const epoch = buf.readUInt32LE(0);
      rx.audio.push({ epoch, bytes: buf.length - 4, index: rx.order });
      if (!started.has(epoch)) {
        started.add(epoch);
        ws.send(JSON.stringify({ type: 'playback_started', epoch }));
      }
      return;
    }
    const msg = JSON.parse(buf.toString()) as Record<string, unknown>;
    rx.json.push({ ...msg, index: rx.order });
    if (msg['type'] === 'mark') ws.send(JSON.stringify({ type: 'mark', name: msg['name'] }));
    if (msg['type'] === 'clear') ws.send(JSON.stringify({ type: 'playback_cleared', epoch: msg['epoch'] }));
    if (msg['type'] === 'ping') ws.send(JSON.stringify({ type: 'pong', id: msg['id'] }));
  });
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve({ ws, rx }));
    ws.once('error', reject);
  });
}

const events = (rx: Received) =>
  rx.json.filter((m) => m['type'] === 'event').map((m) => m['event'] as Record<string, unknown>);

function sendFrames(ws: WebSocket, loud: boolean, count: number): void {
  for (let i = 0; i < count; i += 1) ws.send(frame(loud));
}

describe('dev server + browser transport over a real WebSocket', () => {
  it('serves only whitelisted static files', async () => {
    const s = await start();
    const index = await fetch(`${s.url}/`);
    expect(index.status).toBe(200);
    expect(index.headers.get('content-security-policy')).toContain("default-src 'self'");
    expect((await fetch(`${s.url}/package.json`)).status).toBe(404);
    expect((await fetch(`${s.url}/..%2F.env`)).status).toBe(404);
    expect(await (await fetch(`${s.url}/healthz`)).json()).toEqual({ ok: true, activeSessions: 0 });
  });

  it('rejects WebSocket connections from other origins', async () => {
    const s = await start();
    const ws = new WebSocket(`${s.url.replace('http', 'ws')}/ws`, { origin: 'https://evil.example' });
    const status = await new Promise<number>((resolve) => {
      ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
      ws.on('error', () => resolve(-1));
    });
    expect(status).toBe(403);
  });

  it('streams a full turn: mic frames → engine → epoch-tagged audio → marks → summary', async () => {
    const s = await start();
    const { ws, rx } = await connect(s.url);
    await waitFor(() => rx.json.some((m) => m['type'] === 'session_started'), 2000, 'session_started');
    expect(rx.json.find((m) => m['type'] === 'session_started')?.['config']).toEqual({ llm: { provider: 'fake', model: 'm' }, openai_key_present: false });
    sendFrames(ws, true, 40); // 800ms of "speech"
    sendFrames(ws, false, 45); // 900ms silence → fake STT commits

    await waitFor(() => events(rx).some((e) => e['type'] === 'turn_summary'), 8000, 'turn summary');
    const summary = events(rx).find((e) => e['type'] === 'turn_summary')?.['summary'] as Record<string, unknown>;
    expect(summary['outcome']).toBe('completed');
    // 800ms of energy → the fake STT reveals one word per 300ms of speech.
    expect(events(rx).find((e) => e['type'] === 'user_committed')?.['text']).toBe('السلام عليكم ابي');
    expect(rx.audio.length).toBeGreaterThan(1);
    expect(rx.audio.every((a) => a.epoch === 1 && a.bytes > 0 && a.bytes % 2 === 0)).toBe(true);
    expect((summary['durations_ms'] as Record<string, number>)['e2e_ms']).toBeGreaterThan(0);
    const liveMarks = events(rx).filter((e) => e['type'] === 'timeline').map((e) => e['mark']);
    expect(liveMarks).toEqual(expect.arrayContaining(['stt_committed', 'llm_first_token', 'tts_first_audio', 'tts_done', 'playback_start']));
    ws.close();
  });

  it('interrupts over the wire: pause → clear, and no audio of that epoch after clear', async () => {
    const s = await start(new FakeLanguageModel({ tokenDelayMs: 40 }));
    const { ws, rx } = await connect(s.url);
    await waitFor(() => rx.json.some((m) => m['type'] === 'session_started'), 2000);
    sendFrames(ws, true, 30);
    sendFrames(ws, false, 45);
    await waitFor(() => rx.audio.length >= 3, 8000, 'agent audio');

    // User talks over the agent. The fake's next utterance starts with the backchannel 'طيب',
    // which is ignored; the interrupt comes once a second word arrives.
    sendFrames(ws, true, 20);
    await waitFor(() => rx.json.some((m) => m['type'] === 'clear'), 3000, 'clear');
    const clear = rx.json.find((m) => m['type'] === 'clear');
    expect(clear?.['epoch']).toBe(1);
    expect(events(rx).some((e) => e['type'] === 'barge_in' && e['action'] === 'ignored' && e['reason'] === 'backchannel')).toBe(true);

    await waitFor(() => events(rx).some((e) => e['type'] === 'turn_summary'), 3000, 'interrupted summary');
    const summary = events(rx).find((e) => e['type'] === 'turn_summary')?.['summary'] as Record<string, unknown>;
    expect(summary['outcome']).toBe('interrupted');
    expect((summary['durations_ms'] as Record<string, number>)['interrupt_stop_ms']).toBeGreaterThanOrEqual(0);

    await new Promise((r) => setTimeout(r, 150));
    const clearIndex = clear?.['index'] as number;
    expect(rx.audio.filter((a) => a.epoch === 1 && a.index > clearIndex)).toHaveLength(0);
    ws.close();
  });

  it('ignores malformed client messages without dropping the session', async () => {
    const s = await start();
    const { ws, rx } = await connect(s.url);
    ws.send('not json');
    ws.send(JSON.stringify({ type: 'mark' }));
    ws.send(Buffer.from([1, 2, 3])); // odd-length audio frame
    sendFrames(ws, true, 30);
    sendFrames(ws, false, 45);
    await waitFor(() => events(rx).some((e) => e['type'] === 'turn_summary'), 8000);
    expect(s.activeSessions()).toBe(1);
    ws.close();
  });
});
