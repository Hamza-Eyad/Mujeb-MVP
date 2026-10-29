import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { ElevenLabsRealtimeStt } from '../../src/adapters/elevenlabs/realtime-stt.js';
import { FakeLanguageModel } from '../../src/adapters/fakes/fake-llm.js';
import { FakeTextToSpeech } from '../../src/adapters/fakes/fake-tts.js';
import { CallRouter } from '../../src/app/call-router.js';
import type { AgentRuntime } from '../../src/app/session-factory.js';
import { type TelephonyServer, startTelephonyServer } from '../../src/app/telephony-server.js';
import { createJsonLogger } from '../../src/observability/logger.js';
import { MemoryTurnSink } from '../../src/observability/turn-metrics.js';
import type { VoiceSessionConfig } from '../../src/voice/session.js';
import { type FakeAsterisk, connectFakeAsterisk } from '../support/fake-asterisk.js';
import { TEST_CONFIG, delay, waitFor } from '../support/session-harness.js';

/**
 * STT is ready when the provider confirms the session (ElevenLabs `session_started`), not when its WebSocket
 * opens, and the gateway must not ANSWER before that (PR #5 review). The real ElevenLabs STT adapter talks to
 * a local stand-in here: nothing leaves the machine.
 */

type Behaviour = { kind: 'started_after'; ms: number } | { kind: 'never_started' } | { kind: 'auth_error' };

interface StandIn {
  baseUrl: string;
  connections: number;
  /** Connections the client closed (the server saw the socket end). */
  closed: number;
}

let http: Server | undefined;
let wss: WebSocketServer | undefined;
let server: TelephonyServer | undefined;
const callers: FakeAsterisk[] = [];
afterEach(async () => {
  for (const c of callers.splice(0)) c.ws.terminate();
  await server?.close();
  server = undefined;
  for (const client of wss?.clients ?? []) client.terminate();
  wss?.close();
  await new Promise<void>((resolve) => (http ? http.close(() => resolve()) : resolve()));
  http = undefined;
  wss = undefined;
});

async function startStandIn(behaviour: Behaviour): Promise<StandIn> {
  const standIn: StandIn = { baseUrl: '', connections: 0, closed: 0 };
  http = createServer();
  wss = new WebSocketServer({ noServer: true });
  http.on('upgrade', (req, socket, head) => {
    wss?.handleUpgrade(req, socket, head, (ws) => {
      standIn.connections += 1;
      ws.on('close', () => (standIn.closed += 1));
      if (behaviour.kind === 'started_after') setTimeout(() => ws.send(JSON.stringify({ message_type: 'session_started', config: {} })), behaviour.ms);
      if (behaviour.kind === 'auth_error') ws.send(JSON.stringify({ message_type: 'auth_error', error: 'invalid key' }));
    });
  });
  await new Promise<void>((resolve) => http?.listen(0, '127.0.0.1', () => resolve()));
  standIn.baseUrl = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  return standIn;
}

async function startGateway(standIn: StandIn, sttConnect: VoiceSessionConfig['sttConnect']) {
  const lines: Record<string, unknown>[] = [];
  const runtime: AgentRuntime = {
    profile: { tenantId: 'demo', agentId: 'demo-clinic', displayName: 'Demo', languageCode: 'ar', instructions: 'x', historyMaxTurns: 6, greeting: 'أهلاً وسهلاً' },
    providers: {
      stt: new ElevenLabsRealtimeStt({
        apiKey: 'test-key',
        baseUrl: standIn.baseUrl,
        model: 'stt-model',
        languageCode: 'ar',
        commitStrategy: 'vad',
        vadSilenceSecs: 0.8,
        zeroRetention: false,
        connectTimeoutMs: sttConnect.attemptTimeoutMs,
      }),
      llm: new FakeLanguageModel(),
      tts: new FakeTextToSpeech({ msPerChar: 25, realtimeFactor: 0.2 }),
    },
    sessionConfig: { ...TEST_CONFIG, sttConnect },
    metrics: new MemoryTurnSink(),
  };
  server = await startTelephonyServer({
    host: '127.0.0.1',
    port: 0,
    credentials: { username: 'asterisk', password: 'test-only-secret' },
    maxCalls: 2,
    callStartTimeoutMs: 300,
    answerTimeoutMs: 3000,
    router: new CallRouter([['300', runtime]]),
    log: createJsonLogger({ level: 'info', write: (line) => lines.push(JSON.parse(line) as Record<string, unknown>) }),
  });
  const caller = await connectFakeAsterisk(server.url, { username: 'asterisk', password: 'test-only-secret', autoAckMarks: true, autoStatus: true });
  callers.push(caller);
  return { caller, logged: (event: string) => lines.filter((l) => l['event'] === event) };
}

describe('telephony: ANSWER only after the STT provider confirms the session', () => {
  it('the WebSocket opens but session_started comes later: no ANSWER until it arrives', async () => {
    const standIn = await startStandIn({ kind: 'started_after', ms: 300 });
    const { caller } = await startGateway(standIn, { attempts: 2, attemptTimeoutMs: 1000, retryDelayMs: 10 });
    const sent = Date.now();
    caller.mediaStart({ MUJEEB_DID: '300' });
    await waitFor(() => standIn.connections === 1, 1000, 'STT connection');
    await delay(150);
    expect(caller.commands()).toEqual([]); // the socket is open, the provider has not started the session
    await waitFor(() => caller.commands().includes('ANSWER'), 2000, 'ANSWER');
    expect(Date.now() - sent).toBeGreaterThanOrEqual(290);
    await waitFor(() => caller.commands().includes('MARK_MEDIA:start:1'), 2000, 'greeting');
    expect(standIn.connections).toBe(1);
  });

  it('session_started never arrives: each attempt times out and is closed, then the call is turned away unanswered', async () => {
    const standIn = await startStandIn({ kind: 'never_started' });
    const { caller, logged } = await startGateway(standIn, { attempts: 2, attemptTimeoutMs: 150, retryDelayMs: 10 });
    caller.mediaStart({ MUJEEB_DID: '300', MUJEEB_CALL_ID: '1800.1' });
    expect(await caller.closed).toBe(1000);
    expect(caller.commands()).toEqual(['HANGUP']);
    expect(standIn.connections).toBe(2);
    await waitFor(() => standIn.closed === 2, 1000, 'both STT sockets closed');
    expect(logged('stt.connect_retry')).toHaveLength(1);
    expect(logged('call.start_failed')[0]).toMatchObject({ call_id: '1800.1', answered: false, error_kind: 'timeout' });
  });

  it('the caller hangs up while waiting for session_started: the STT socket is closed at once, no ANSWER, no retry', async () => {
    const standIn = await startStandIn({ kind: 'never_started' });
    const { caller, logged } = await startGateway(standIn, { attempts: 2, attemptTimeoutMs: 5000, retryDelayMs: 10 });
    caller.mediaStart({ MUJEEB_DID: '300', MUJEEB_CALL_ID: '1800.3' });
    await waitFor(() => standIn.connections === 1, 1000, 'STT connection');
    await delay(50); // the STT WebSocket is open, the session is not started
    caller.ws.close(1000);
    await waitFor(() => standIn.closed === 1, 1000, 'STT socket closed'); // well before the 5s attempt timeout
    await delay(100);
    expect(standIn.connections).toBe(1);
    expect(caller.commands()).not.toContain('ANSWER');
    expect(logged('call.abandoned')[0]).toMatchObject({ call_id: '1800.3', stage: 'before_answer' });
  });

  it('auth_error before session_started: no ANSWER, no retry, and the STT socket is closed', async () => {
    const standIn = await startStandIn({ kind: 'auth_error' });
    const { caller, logged } = await startGateway(standIn, { attempts: 2, attemptTimeoutMs: 1000, retryDelayMs: 10 });
    caller.mediaStart({ MUJEEB_DID: '300', MUJEEB_CALL_ID: '1800.2' });
    expect(await caller.closed).toBe(1000);
    expect(caller.commands()).toEqual(['HANGUP']);
    expect(standIn.connections).toBe(1);
    await waitFor(() => standIn.closed === 1, 1000, 'STT socket closed');
    expect(logged('stt.connect_retry')).toHaveLength(0);
    expect(logged('call.start_failed')[0]).toMatchObject({ call_id: '1800.2', answered: false, error_kind: 'auth' });
  });
});
