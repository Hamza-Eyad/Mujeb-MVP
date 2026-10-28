import { afterEach, describe, expect, it } from 'vitest';
import { FakeLanguageModel } from '../../src/adapters/fakes/fake-llm.js';
import { FakeSpeechToText } from '../../src/adapters/fakes/fake-stt.js';
import { FakeTextToSpeech } from '../../src/adapters/fakes/fake-tts.js';
import { CallRouter } from '../../src/app/call-router.js';
import type { AgentRuntime } from '../../src/app/session-factory.js';
import { type TelephonyServer, startTelephonyServer } from '../../src/app/telephony-server.js';
import { silentLogger } from '../../src/core/logger.js';
import { createJsonLogger } from '../../src/observability/logger.js';
import { MemoryTurnSink } from '../../src/observability/turn-metrics.js';
import { type FakeAsterisk, connectFakeAsterisk } from '../support/fake-asterisk.js';
import { TEST_CONFIG, delay, frame, waitFor } from '../support/session-harness.js';

const CREDENTIALS = { username: 'asterisk', password: 'test-only-secret' };

function runtime(metrics = new MemoryTurnSink()): AgentRuntime {
  return {
    profile: { tenantId: 'demo', agentId: 'demo-clinic', displayName: 'Demo', languageCode: 'ar', instructions: 'x', historyMaxTurns: 6, greeting: 'أهلاً وسهلاً' },
    providers: { stt: new FakeSpeechToText({ mode: 'energy' }), llm: new FakeLanguageModel(), tts: new FakeTextToSpeech({ msPerChar: 25, realtimeFactor: 0.2 }) },
    sessionConfig: TEST_CONFIG,
    metrics,
  };
}

let server: TelephonyServer | undefined;
let metrics = new MemoryTurnSink();
const callers: FakeAsterisk[] = [];
afterEach(async () => {
  for (const c of callers.splice(0)) c.ws.terminate();
  await server?.close();
  server = undefined;
});

async function start(maxCalls = 2): Promise<TelephonyServer> {
  metrics = new MemoryTurnSink();
  server = await startTelephonyServer({
    host: '127.0.0.1',
    port: 0,
    credentials: CREDENTIALS,
    maxCalls,
    callStartTimeoutMs: 300,
    router: new CallRouter([['300', runtime(metrics)]]),
    log: silentLogger,
  });
  return server;
}

async function dial(s: TelephonyServer, options: Parameters<typeof connectFakeAsterisk>[1] = { ...CREDENTIALS, autoAckMarks: true, autoStatus: true }): Promise<FakeAsterisk> {
  const caller = await connectFakeAsterisk(s.url, options);
  callers.push(caller);
  return caller;
}

describe('telephony server (Asterisk chan_websocket → VoiceSession)', () => {
  it('refuses connections without the shared secret or on another path', async () => {
    const s = await start();
    await expect(dial(s, { username: 'asterisk', password: 'wrong' })).rejects.toThrow('HTTP 401');
    await expect(dial(s, {})).rejects.toThrow('HTTP 401');
    await expect(dial({ ...s, url: s.url.replace('/media', '/other') }, CREDENTIALS)).rejects.toThrow('HTTP 404');
    expect(s.activeCalls()).toBe(0);
  });

  it('answers a routed call only after its session exists, then plays the greeting in whole frames', async () => {
    const s = await start();
    const caller = await dial(s);
    caller.mediaStart({ MUJEEB_DID: '300', MUJEEB_CALLER: '0551234567', MUJEEB_CALL_ID: '1700.1' });
    await waitFor(() => caller.commands().includes('ANSWER'), 2000, 'ANSWER');
    await waitFor(() => caller.commands().some((c) => /^MARK_MEDIA:\d+:\d+$/.test(c)), 4000, 'greeting marks');
    expect(caller.commands()[0]).toBe('ANSWER');
    expect(caller.commands()).toContain('MARK_MEDIA:start:1');
    expect(caller.received.filter((r) => r.kind === 'audio').every((r) => r.bytes % 640 === 0)).toBe(true);
    expect(s.activeCalls()).toBe(1);

    caller.ws.close(1000);
    await waitFor(() => s.activeCalls() === 0, 2000, 'call released');
  });

  it('hears the caller and answers a turn, recording it as a phone turn of this call', async () => {
    const s = await start();
    const caller = await dial(s);
    caller.mediaStart({ MUJEEB_DID: '300', MUJEEB_CALL_ID: '1700.7' });
    await waitFor(() => caller.commands().includes('ANSWER'), 2000, 'ANSWER');
    await waitFor(() => caller.commands().includes('MARK_MEDIA:start:1'), 2000, 'greeting');
    await delay(400); // let the greeting finish
    for (let i = 0; i < 40; i += 1) caller.sendAudio(frame(true)); // 800ms of "speech"
    for (let i = 0; i < 45; i += 1) caller.sendAudio(frame(false)); // silence → the fake STT commits
    await waitFor(() => caller.commands().includes('MARK_MEDIA:start:2'), 8000, 'reply to the caller');
    await waitFor(() => metrics.summaries.some((t) => t.kind === 'user'), 8000, 'user turn summary');
    expect(metrics.summaries.length).toBeGreaterThanOrEqual(2);
    expect(metrics.summaries.every((t) => t.channel === 'phone' && t.call_id === '1700.7')).toBe(true);
  });

  it('refuses an unknown number before answering', async () => {
    const s = await start();
    const caller = await dial(s);
    caller.mediaStart({ MUJEEB_DID: '999' });
    expect(await caller.closed).toBe(1000);
    expect(caller.commands()).toEqual(['HANGUP']);
  });

  it('hangs up when MEDIA_START never arrives', async () => {
    const s = await start();
    const caller = await dial(s);
    expect(await caller.closed).toBe(1000);
    expect(caller.commands()).toEqual(['HANGUP']);
  });

  it('logs its health periodically when asked: calls, event-loop delay and memory', async () => {
    const lines: Record<string, unknown>[] = [];
    server = await startTelephonyServer({
      host: '127.0.0.1',
      port: 0,
      credentials: CREDENTIALS,
      maxCalls: 2,
      callStartTimeoutMs: 300,
      healthLogMs: 40,
      router: new CallRouter([['300', runtime()]]),
      log: createJsonLogger({ level: 'info', write: (line) => lines.push(JSON.parse(line) as Record<string, unknown>) }),
    });
    const caller = await dial(server);
    caller.mediaStart({ MUJEEB_DID: '300' });
    await waitFor(() => lines.some((l) => l['event'] === 'gateway.health' && l['active_calls'] === 1), 2000, 'health line with the call');
    const health = lines.find((l) => l['event'] === 'gateway.health' && l['active_calls'] === 1);
    expect(health).toMatchObject({ sessions: 1, event_loop_p99_ms: expect.any(Number) as unknown, heap_used_mb: expect.any(Number) as unknown, rss_mb: expect.any(Number) as unknown });

    await server.close();
    server = undefined;
    const count = lines.filter((l) => l['event'] === 'gateway.health').length;
    await delay(120);
    expect(lines.filter((l) => l['event'] === 'gateway.health').length).toBe(count); // stopped on close
  });

  it('refuses a call over capacity and frees the slot when a call ends', async () => {
    const s = await start(1);
    const first = await dial(s);
    first.mediaStart({ MUJEEB_DID: '300' });
    await waitFor(() => first.commands().includes('ANSWER'), 2000, 'first answered');
    await expect(dial(s)).rejects.toThrow('HTTP 503');

    first.ws.close(1000);
    await waitFor(() => s.activeCalls() === 0, 2000, 'slot freed');
    const second = await dial(s);
    second.mediaStart({ MUJEEB_DID: '300' });
    await waitFor(() => second.commands().includes('ANSWER'), 2000, 'second answered');
  });
});
