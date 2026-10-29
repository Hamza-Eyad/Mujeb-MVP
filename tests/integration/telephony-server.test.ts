import { afterEach, describe, expect, it } from 'vitest';
import { FakeLanguageModel } from '../../src/adapters/fakes/fake-llm.js';
import { FakeSpeechToText } from '../../src/adapters/fakes/fake-stt.js';
import { FakeTextToSpeech } from '../../src/adapters/fakes/fake-tts.js';
import { CallRouter } from '../../src/app/call-router.js';
import type { AgentRuntime } from '../../src/app/session-factory.js';
import { type TelephonyServer, startTelephonyServer } from '../../src/app/telephony-server.js';
import { ProviderError } from '../../src/core/errors.js';
import { createJsonLogger } from '../../src/observability/logger.js';
import { MemoryTurnSink } from '../../src/observability/turn-metrics.js';
import { type FakeAsterisk, connectFakeAsterisk } from '../support/fake-asterisk.js';
import { TEST_CONFIG, delay, frame, waitFor } from '../support/session-harness.js';

const CREDENTIALS = { username: 'asterisk', password: 'test-only-secret' };

function runtime(metrics = new MemoryTurnSink(), stt = new FakeSpeechToText({ mode: 'energy' }), sessionConfig = TEST_CONFIG): AgentRuntime {
  return {
    profile: { tenantId: 'demo', agentId: 'demo-clinic', displayName: 'Demo', languageCode: 'ar', instructions: 'x', historyMaxTurns: 6, greeting: 'أهلاً وسهلاً' },
    providers: { stt, llm: new FakeLanguageModel(), tts: new FakeTextToSpeech({ msPerChar: 25, realtimeFactor: 0.2 }) },
    sessionConfig,
    metrics,
  };
}

let server: TelephonyServer | undefined;
let metrics = new MemoryTurnSink();
let logLines: Record<string, unknown>[] = [];
const callers: FakeAsterisk[] = [];
afterEach(async () => {
  for (const c of callers.splice(0)) c.ws.terminate();
  await server?.close();
  server = undefined;
});

interface StartOptions {
  maxCalls?: number;
  stt?: FakeSpeechToText;
  sessionConfig?: typeof TEST_CONFIG;
  answerTimeoutMs?: number;
}

async function start({ maxCalls = 2, stt, sessionConfig, answerTimeoutMs = 2000 }: StartOptions = {}): Promise<TelephonyServer> {
  metrics = new MemoryTurnSink();
  logLines = [];
  server = await startTelephonyServer({
    host: '127.0.0.1',
    port: 0,
    credentials: CREDENTIALS,
    maxCalls,
    callStartTimeoutMs: 300,
    answerTimeoutMs,
    router: new CallRouter([['300', runtime(metrics, stt, sessionConfig)]]),
    log: createJsonLogger({ level: 'info', write: (line) => logLines.push(JSON.parse(line) as Record<string, unknown>) }),
  });
  return server;
}

const logged = (event: string) => logLines.filter((l) => l['event'] === event);

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
      answerTimeoutMs: 2000,
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
    const s = await start({ maxCalls: 1 });
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

describe('telephony server: STT connects before ANSWER', () => {
  it('answers only once STT is connected: a stalled first attempt is aborted and retried, then the greeting plays', async () => {
    const stt = new FakeSpeechToText({ mode: 'energy', hangOpen: { times: 1 } });
    const s = await start({ stt });
    const caller = await dial(s);
    caller.mediaStart({ MUJEEB_DID: '300', MUJEEB_CALL_ID: '1700.20' });
    await delay(100);
    expect(caller.commands()).toEqual([]); // still ringing while the first attempt stalls
    await waitFor(() => caller.commands().includes('ANSWER'), 2000, 'ANSWER');
    expect(stt.attempts.map((a) => a.outcome)).toEqual(['aborted', 'open']);
    await waitFor(() => caller.commands().includes('MARK_MEDIA:start:1'), 2000, 'greeting');
    expect(caller.commands()[0]).toBe('ANSWER');
    expect(caller.received.findIndex((r) => r.kind === 'audio')).toBeGreaterThan(caller.received.findIndex((r) => r.kind === 'command' && r.command === 'ANSWER'));
    expect(logged('stt.connect_retry')).toHaveLength(1);
  });

  it('turns the call away unanswered when STT cannot connect: HANGUP and close, nothing left open', async () => {
    const stt = new FakeSpeechToText({ mode: 'energy', hangOpen: { times: 2 } });
    const s = await start({ stt });
    const caller = await dial(s);
    caller.mediaStart({ MUJEEB_DID: '300', MUJEEB_CALL_ID: '1700.21' });
    expect(await caller.closed).toBe(1000);
    expect(caller.commands()).toEqual(['HANGUP']); // never answered: the dialplan plays the apology
    expect(stt.attempts.map((a) => a.outcome)).toEqual(['aborted', 'aborted']);
    expect(logged('call.start_failed')[0]).toMatchObject({ call_id: '1700.21', answered: false, error_kind: 'timeout' });
    await waitFor(() => s.activeCalls() === 0, 1000, 'slot freed');
  });

  it('does not retry an authentication error', async () => {
    const stt = new FakeSpeechToText({ mode: 'energy', failOpen: { times: 1, error: new ProviderError('fake-stt', 'auth', 'bad key') } });
    const s = await start({ stt });
    const caller = await dial(s);
    caller.mediaStart({ MUJEEB_DID: '300' });
    expect(await caller.closed).toBe(1000);
    expect(caller.commands()).toEqual(['HANGUP']);
    expect(stt.attempts.map((a) => a.outcome)).toEqual(['failed']);
    expect(logged('call.start_failed')[0]).toMatchObject({ error_kind: 'auth', answered: false });
  });

  it('the answer deadline bounds both attempts and the pause between them', async () => {
    const stt = new FakeSpeechToText({ mode: 'energy', hangOpen: { times: 2 } });
    const s = await start({ stt, answerTimeoutMs: 200 }); // shorter than 150 + 10 + 150
    const caller = await dial(s);
    const started = Date.now();
    caller.mediaStart({ MUJEEB_DID: '300' });
    expect(await caller.closed).toBe(1000);
    expect(Date.now() - started).toBeLessThan(290);
    expect(caller.commands()).toEqual(['HANGUP']);
    expect(stt.attempts.map((a) => a.outcome)).toEqual(['aborted', 'aborted']);
  });

  it('the caller hangs up while STT connects: the attempt is aborted at once, no ANSWER, no session left', async () => {
    const stt = new FakeSpeechToText({ mode: 'energy', hangOpen: { times: 1 } });
    const s = await start({ stt, sessionConfig: { ...TEST_CONFIG, sttConnect: { attempts: 2, attemptTimeoutMs: 5000, retryDelayMs: 10 } } });
    const caller = await dial(s);
    caller.mediaStart({ MUJEEB_DID: '300', MUJEEB_CALL_ID: '1700.22' });
    await waitFor(() => stt.attempts.length === 1, 1000, 'first attempt');
    caller.ws.close(1000);
    await waitFor(() => stt.attempts[0]?.outcome === 'aborted', 500, 'attempt aborted'); // well before its 5s timeout
    await waitFor(() => s.activeCalls() === 0, 1000, 'slot freed');
    await delay(100);
    expect(stt.attempts).toHaveLength(1); // no retry after the hang-up
    expect(caller.commands()).not.toContain('ANSWER');
    expect(logged('call.abandoned')[0]).toMatchObject({ call_id: '1700.22', stage: 'before_answer' });
    expect(logged('call.start_failed')).toHaveLength(0);
  });
});
