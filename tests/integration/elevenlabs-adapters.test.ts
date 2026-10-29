import { createServer, type Server } from 'node:http';
import { type AddressInfo, type Socket, createServer as createNetServer } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { ElevenLabsTts } from '../../src/adapters/elevenlabs/multi-context-tts.js';
import { ElevenLabsRealtimeStt } from '../../src/adapters/elevenlabs/realtime-stt.js';
import { pcm16 } from '../../src/core/audio.js';
import { CancelledError, ConfigError, ProviderError } from '../../src/core/errors.js';
import { silentLogger, type Logger } from '../../src/core/logger.js';
import type { SttEvent } from '../../src/ports/speech-to-text.js';
import type { TtsAudioChunk } from '../../src/ports/text-to-speech.js';
import { delay, waitFor } from '../support/session-harness.js';

/** Local stand-in for the ElevenLabs WebSocket APIs (protocol per the official API reference). */
interface FakeProvider {
  baseUrl: string;
  connections: Array<{ url: URL; headers: Record<string, string | string[] | undefined>; ws: WebSocket; received: Array<Record<string, unknown>> }>;
}

let http: Server | undefined;
let wss: WebSocketServer | undefined;
afterEach(async () => {
  for (const client of wss?.clients ?? []) client.terminate();
  wss?.close();
  await new Promise<void>((resolve) => (http ? http.close(() => resolve()) : resolve()));
  http = undefined;
  wss = undefined;
});

async function startProvider(options: {
  rejectStatus?: number;
  onConnection?: (conn: FakeProvider['connections'][number]) => void;
  onMessage?: (conn: FakeProvider['connections'][number], msg: Record<string, unknown>) => void;
}): Promise<FakeProvider> {
  const provider: FakeProvider = { baseUrl: '', connections: [] };
  http = createServer();
  wss = new WebSocketServer({ noServer: true });
  http.on('upgrade', (req, socket, head) => {
    if (options.rejectStatus) {
      socket.end(`HTTP/1.1 ${options.rejectStatus} Rejected\r\n\r\n`);
      return;
    }
    wss?.handleUpgrade(req, socket, head, (ws) => {
      const conn = { url: new URL(req.url ?? '/', 'http://x'), headers: req.headers, ws, received: [] as Array<Record<string, unknown>> };
      provider.connections.push(conn);
      ws.on('message', (data: Buffer) => {
        const msg = JSON.parse(data.toString()) as Record<string, unknown>;
        conn.received.push(msg);
        options.onMessage?.(conn, msg);
      });
      options.onConnection?.(conn);
    });
  });
  await new Promise<void>((resolve) => http?.listen(0, '127.0.0.1', () => resolve()));
  provider.baseUrl = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  return provider;
}

function capturingLogger(): Logger & { records: Array<{ level: string; event: string; fields?: Record<string, unknown> }> } {
  const records: Array<{ level: string; event: string; fields?: Record<string, unknown> }> = [];
  const make = (): Logger => ({
    debug: (event, fields) => records.push({ level: 'debug', event, ...(fields ? { fields } : {}) }),
    info: (event, fields) => records.push({ level: 'info', event, ...(fields ? { fields } : {}) }),
    warn: (event, fields) => records.push({ level: 'warn', event, ...(fields ? { fields } : {}) }),
    error: (event, fields) => records.push({ level: 'error', event, ...(fields ? { fields } : {}) }),
    child: () => make(),
  });
  return Object.assign(make(), { records });
}

describe('ElevenLabsRealtimeStt', () => {
  const sttOptions = (baseUrl: string, extra: Partial<ConstructorParameters<typeof ElevenLabsRealtimeStt>[0]> = {}) =>
    new ElevenLabsRealtimeStt({ apiKey: 'el-key', baseUrl, model: 'stt-model', languageCode: 'ar', commitStrategy: 'vad', vadSilenceSecs: 0.8, zeroRetention: false, ...extra });

  it('connects with the configured query, streams base64 audio, and maps transcripts', async () => {
    const provider = await startProvider({
      onConnection: (conn) =>
        conn.ws.send(JSON.stringify({ message_type: 'session_started', session_id: 's1', config: { commit_strategy: 'vad', model_id: 'stt-model' } })),
    });
    const events: SttEvent[] = [];
    const stream = await sttOptions(provider.baseUrl).open({ format: pcm16(16000), onEvent: (e) => events.push(e), signal: new AbortController().signal, log: silentLogger });
    const conn = provider.connections[0];
    if (!conn) throw new Error('no connection');
    expect(conn.headers['xi-api-key']).toBe('el-key');
    expect(conn.url.pathname).toBe('/v1/speech-to-text/realtime');
    expect(Object.fromEntries(conn.url.searchParams)).toEqual({
      model_id: 'stt-model',
      audio_format: 'pcm_16000',
      commit_strategy: 'vad',
      language_code: 'ar',
      vad_silence_threshold_secs: '0.8',
    });

    const audio = new Uint8Array([1, 2, 3, 4]);
    stream.sendAudio(audio);
    await waitFor(() => conn.received.length === 1);
    expect(conn.received[0]).toEqual({ message_type: 'input_audio_chunk', audio_base_64: Buffer.from(audio).toString('base64'), commit: false, sample_rate: 16000 });

    conn.ws.send(JSON.stringify({ message_type: 'partial_transcript', text: 'السلام' }));
    conn.ws.send(JSON.stringify({ message_type: 'committed_transcript', text: 'السلام عليكم' }));
    conn.ws.send(JSON.stringify({ message_type: 'committed_transcript_with_timestamps', text: 'السلام عليكم', words: [] }));
    conn.ws.send(JSON.stringify({ message_type: 'rate_limited', error: 'slow down' }));
    await waitFor(() => events.length >= 4);
    await new Promise((r) => setTimeout(r, 30));
    expect(events.map((e) => e.type)).toEqual(['ready', 'partial', 'committed', 'warning']);
    expect(events[2]).toEqual({ type: 'committed', text: 'السلام عليكم' }); // no duplicate from *_with_timestamps
    await stream.close();
  });

  it('requests zero retention and warns when the server does not apply the requested settings', async () => {
    const provider = await startProvider({
      onConnection: (conn) =>
        conn.ws.send(JSON.stringify({ message_type: 'session_started', config: { commit_strategy: 'vad', enable_logging: true } })),
    });
    const log = capturingLogger();
    const events: SttEvent[] = [];
    const stream = await sttOptions(provider.baseUrl, { commitStrategy: 'turn_prediction', zeroRetention: true }).open({
      format: pcm16(16000),
      onEvent: (e) => events.push(e),
      signal: new AbortController().signal,
      log,
    });
    await waitFor(() => events.length === 1);
    expect(provider.connections[0]?.url.searchParams.get('enable_logging')).toBe('false');
    const mismatches = log.records.filter((r) => r.event === 'stt.config_mismatch').map((r) => r.fields?.['key']);
    expect(mismatches).toEqual(['commit_strategy', 'zero_retention']);
    await stream.close();
  });

  it('understands the session config shape the live API actually sends (vad_commit_strategy / disable_logging)', async () => {
    // Captured from the real API on 2026-10-08 (abridged).
    const liveConfig = { sample_rate: 16000, audio_format: 'pcm_16000', language_code: 'ar', vad_commit_strategy: true, model_id: 'stt-model', disable_logging: false };
    const provider = await startProvider({ onConnection: (conn) => conn.ws.send(JSON.stringify({ message_type: 'session_started', config: liveConfig })) });
    const log = capturingLogger();
    const events: SttEvent[] = [];
    const stream = await sttOptions(provider.baseUrl, { zeroRetention: true }).open({ format: pcm16(16000), onEvent: (e) => events.push(e), signal: new AbortController().signal, log });
    await waitFor(() => events.length === 1);
    const mismatches = log.records.filter((r) => r.event === 'stt.config_mismatch').map((r) => r.fields);
    expect(mismatches).toEqual([{ key: 'zero_retention', requested: true, effective: false }]); // vad matched; ZRM silently not applied
    await stream.close();
  });

  it('reports a fatal auth error during the session as a non-retryable close', async () => {
    const provider = await startProvider({ onConnection: (conn) => conn.ws.send(JSON.stringify({ message_type: 'session_started', config: {} })) });
    const events: SttEvent[] = [];
    await sttOptions(provider.baseUrl).open({ format: pcm16(16000), onEvent: (e) => events.push(e), signal: new AbortController().signal, log: silentLogger });
    provider.connections[0]?.ws.send(JSON.stringify({ message_type: 'auth_error', error: 'invalid key' }));
    await waitFor(() => events.some((e) => e.type === 'closed'));
    const closed = events.find((e) => e.type === 'closed');
    expect(closed?.type === 'closed' && closed.error).toMatchObject({ kind: 'auth', retryable: false });
  });

  it('open() resolves on session_started, not when the WebSocket opens', async () => {
    const provider = await startProvider({
      onConnection: (conn) => setTimeout(() => conn.ws.send(JSON.stringify({ message_type: 'session_started', config: {} })), 150),
    });
    const events: SttEvent[] = [];
    let opened = false;
    const started = Date.now();
    const opening = sttOptions(provider.baseUrl)
      .open({ format: pcm16(16000), onEvent: (e) => events.push(e), signal: new AbortController().signal, log: silentLogger })
      .then((stream) => {
        opened = true;
        return stream;
      });
    await waitFor(() => provider.connections.length === 1, 1000, 'connection');
    await delay(50);
    expect(opened).toBe(false); // the socket is open; the session is not started yet
    const stream = await opening;
    expect(Date.now() - started).toBeGreaterThanOrEqual(140);
    expect(events.map((e) => e.type)).toEqual(['ready']);
    await stream.close();
  });

  it('no session_started: open() times out (retryable), closes the socket, and reports nothing afterwards', async () => {
    const closed: number[] = [];
    const provider = await startProvider({ onConnection: (conn) => conn.ws.on('close', (code) => closed.push(code)) });
    const events: SttEvent[] = [];
    const error = await sttOptions(provider.baseUrl, { connectTimeoutMs: 200 })
      .open({ format: pcm16(16000), onEvent: (e) => events.push(e), signal: new AbortController().signal, log: silentLogger })
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ kind: 'timeout', retryable: true });
    await waitFor(() => closed.length === 1, 1000, 'socket closed by the client');
    expect(provider.connections).toHaveLength(1);
    await delay(30);
    expect(events).toEqual([]); // no `closed` event for a stream that never started (it would start a reconnect)
  });

  it('auth_error before session_started: open() rejects at once, not retryable, and closes the socket', async () => {
    const closed: number[] = [];
    const provider = await startProvider({
      onConnection: (conn) => {
        conn.ws.on('close', (code) => closed.push(code));
        conn.ws.send(JSON.stringify({ message_type: 'auth_error', error: 'invalid key' }));
      },
    });
    const events: SttEvent[] = [];
    const started = Date.now();
    const error = await sttOptions(provider.baseUrl, { connectTimeoutMs: 5000 })
      .open({ format: pcm16(16000), onEvent: (e) => events.push(e), signal: new AbortController().signal, log: silentLogger })
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ kind: 'auth', retryable: false });
    expect(Date.now() - started).toBeLessThan(1000); // not the 5s timeout
    await waitFor(() => closed.length === 1, 1000, 'socket closed by the client');
    await delay(30);
    expect(events).toEqual([]);
  });

  it('cancelled while waiting for session_started: rejects with the reason and closes the socket', async () => {
    const closed: number[] = [];
    const provider = await startProvider({ onConnection: (conn) => conn.ws.on('close', (code) => closed.push(code)) });
    const controller = new AbortController();
    const opening = sttOptions(provider.baseUrl, { connectTimeoutMs: 5000 }).open({ format: pcm16(16000), onEvent: () => {}, signal: controller.signal, log: silentLogger });
    await waitFor(() => provider.connections.length === 1, 1000, 'connection');
    await delay(30); // the WebSocket is open now
    controller.abort(new CancelledError('caller_hung_up'));
    await expect(opening).rejects.toBeInstanceOf(CancelledError);
    await waitFor(() => closed.length === 1, 1000, 'socket closed by the client');
  });

  it('the server closes before session_started: open() rejects as unavailable (retryable)', async () => {
    const provider = await startProvider({ onConnection: (conn) => conn.ws.close(1011, 'overloaded') });
    const events: SttEvent[] = [];
    const error = await sttOptions(provider.baseUrl, { connectTimeoutMs: 5000 })
      .open({ format: pcm16(16000), onEvent: (e) => events.push(e), signal: new AbortController().signal, log: silentLogger })
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ kind: 'unavailable', retryable: true });
    expect(events).toEqual([]);
  });

  it('maps a rejected handshake to a ProviderError', async () => {
    const provider = await startProvider({ rejectStatus: 401 });
    const error = await sttOptions(provider.baseUrl)
      .open({ format: pcm16(16000), onEvent: () => {}, signal: new AbortController().signal, log: silentLogger })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ kind: 'auth', retryable: false });
  });

  it('a cancelled opening closes its socket: a stalled handshake is not left to finish', async () => {
    // A server that accepts TCP and never answers the upgrade (the 2026-10-28 lab failure, without any network).
    const sockets: Socket[] = [];
    const closedSockets: Socket[] = [];
    const stalled = createNetServer((socket) => {
      sockets.push(socket);
      socket.resume(); // read, so the client's FIN is seen
      socket.on('close', () => closedSockets.push(socket));
    });
    await new Promise<void>((resolve) => stalled.listen(0, '127.0.0.1', resolve));
    try {
      const controller = new AbortController();
      const opening = sttOptions(`http://127.0.0.1:${(stalled.address() as AddressInfo).port}`, { connectTimeoutMs: 10_000 }).open({
        format: pcm16(16000),
        onEvent: () => {},
        signal: controller.signal,
        log: silentLogger,
      });
      await waitFor(() => sockets.length === 1, 1000, 'connection');
      controller.abort(new ProviderError('elevenlabs-stt', 'timeout', 'attempt timed out'));
      await expect(opening).rejects.toMatchObject({ kind: 'timeout' });
      await waitFor(() => closedSockets.length === 1, 1000, 'socket closed by the client');
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => stalled.close(() => resolve()));
    }
  });

  it('accepts telephony μ-law input without transcoding', async () => {
    const provider = await startProvider({ onConnection: (conn) => conn.ws.send(JSON.stringify({ message_type: 'session_started', config: {} })) });
    const stream = await sttOptions(provider.baseUrl).open({
      format: { encoding: 'mulaw', sampleRate: 8000, channels: 1 },
      onEvent: () => {},
      signal: new AbortController().signal,
      log: silentLogger,
    });
    expect(provider.connections[0]?.url.searchParams.get('audio_format')).toBe('ulaw_8000');
    await stream.close();
  });
});

describe('ElevenLabsTts (multi-context)', () => {
  const ttsOptions = (baseUrl: string) =>
    new ElevenLabsTts({ apiKey: 'el-key', baseUrl, model: 'tts-model', voiceId: 'voice-1', zeroRetention: false, finalTimeoutMs: 500 });

  /**
   * Provider double matching behaviour observed on the real API (2026-10-08): each flushed text yields
   * audio chunks and then an isFinal for that flush; close_context yields a last isFinal.
   */
  function audioReplier(options: { lateAudioForContext?: string } = {}) {
    return (conn: FakeProvider['connections'][number], msg: Record<string, unknown>): void => {
      const contextId = msg['context_id'] as string | undefined;
      if (typeof msg['text'] === 'string' && msg['text'].trim() !== '' && contextId) {
        const text = msg['text'];
        const half = Math.ceil(text.length / 2);
        for (const part of [text.slice(0, half), text.slice(half)]) {
          conn.ws.send(JSON.stringify({ audio: Buffer.from([1, 0, 2, 0]).toString('base64'), contextId, alignment: { chars: [...part] } }));
        }
        conn.ws.send(JSON.stringify({ audio: null, contextId, isFinal: true }));
      }
      if (msg['close_context'] === true && contextId) {
        if (options.lateAudioForContext === contextId) conn.ws.send(JSON.stringify({ audio: Buffer.from([9, 9]).toString('base64'), contextId }));
        conn.ws.send(JSON.stringify({ contextId, isFinal: true }));
      }
    };
  }

  async function* segments(items: string[], failAfter?: Error): AsyncGenerator<string> {
    for (const item of items) {
      await new Promise((r) => setTimeout(r, 5));
      yield item;
    }
    if (failAfter) throw failAfter;
  }

  it('streams one context per utterance with alignment, ending on isFinal', async () => {
    const provider = await startProvider({ onMessage: audioReplier() });
    const session = await ttsOptions(provider.baseUrl).open({ format: pcm16(16000), log: silentLogger });
    const conn = provider.connections[0];
    expect(conn?.url.pathname).toBe('/v1/text-to-speech/voice-1/multi-stream-input');
    expect(conn?.url.searchParams.get('output_format')).toBe('pcm_16000');
    expect(conn?.url.searchParams.get('sync_alignment')).toBe('true');
    expect(conn?.headers['xi-api-key']).toBe('el-key');

    const chunks: TtsAudioChunk[] = [];
    for await (const chunk of session.speak({ utteranceId: 'u1', text: segments(['هلا والله،', 'كيف أقدر أساعدك؟']), signal: new AbortController().signal })) {
      chunks.push(chunk);
    }
    expect(chunks).toHaveLength(4);
    expect(chunks.map((c) => c.text).join('')).toBe('هلا والله، كيف أقدر أساعدك؟ ');
    const sent = conn?.received ?? [];
    expect(sent[0]).toEqual({ text: 'هلا والله، ', context_id: 'u1', flush: true });
    expect(sent.slice(-2)).toEqual([{ context_id: 'u1', flush: true }, { context_id: 'u1', close_context: true }]);
    await session.close();
  });

  it('cancels at the provider on abort and drops late audio from the closed context', async () => {
    const provider = await startProvider({ onMessage: audioReplier({ lateAudioForContext: 'u1' }) });
    const session = await ttsOptions(provider.baseUrl).open({ format: pcm16(16000), log: silentLogger });
    const controller = new AbortController();
    const first: TtsAudioChunk[] = [];
    const error = await (async () => {
      for await (const chunk of session.speak({ utteranceId: 'u1', text: segments(['جملة أولى طويلة،', 'جملة ثانية']), signal: controller.signal })) {
        first.push(chunk);
        controller.abort(new CancelledError('barge_in'));
      }
    })().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CancelledError);
    expect(first).toHaveLength(1);
    const conn = provider.connections[0];
    await waitFor(() => (conn?.received ?? []).some((m) => m['close_context'] === true && m['context_id'] === 'u1'));

    // The next utterance on the same connection must not receive u1's late audio.
    const second: TtsAudioChunk[] = [];
    for await (const chunk of session.speak({ utteranceId: 'u2', text: segments(['رد جديد']), signal: new AbortController().signal })) second.push(chunk);
    expect(second.every((c) => c.data.byteLength === 4)).toBe(true);
    expect(second.map((c) => c.text).join('')).toBe('رد جديد ');
    await session.close();
  });

  it('fails explicitly when the provider finishes a context without any audio (e.g. voice not allowed on the plan)', async () => {
    const provider = await startProvider({
      onMessage: (conn, msg) => {
        if (msg['context_id']) conn.ws.send(JSON.stringify({ audio: null, isFinal: true, alignment: null, contextId: msg['context_id'] }));
      },
    });
    const session = await ttsOptions(provider.baseUrl).open({ format: pcm16(16000), log: silentLogger });
    const error = await (async () => {
      for await (const _ of session.speak({ utteranceId: 'u1', text: segments(['مرحبا، ', 'هذا اختبار.']), signal: new AbortController().signal })) {
        /* drain */
      }
    })().catch((e: unknown) => e);
    expect(error).toMatchObject({ provider: 'elevenlabs-tts', kind: 'bad_request', retryable: false });
    await session.close();
  });

  it('closes the context and propagates the error when the text source fails', async () => {
    const provider = await startProvider({ onMessage: audioReplier() });
    const session = await ttsOptions(provider.baseUrl).open({ format: pcm16(16000), log: silentLogger });
    const failure = new ProviderError('openai', 'unavailable', 'llm died');
    const error = await (async () => {
      for await (const _ of session.speak({ utteranceId: 'u1', text: segments(['بداية الرد،'], failure), signal: new AbortController().signal })) {
        /* drain */
      }
    })().catch((e: unknown) => e);
    expect(error).toBe(failure);
    await waitFor(() => provider.connections[0]?.received.some((m) => m['close_context'] === true) === true, 1000, 'close_context');
    await session.close();
  });

  it('reconnects lazily after the provider closes an idle connection', async () => {
    const provider = await startProvider({ onMessage: audioReplier() });
    const session = await ttsOptions(provider.baseUrl).open({ format: pcm16(16000), log: silentLogger });
    provider.connections[0]?.ws.close(1000, 'inactivity');
    await new Promise((r) => setTimeout(r, 50));
    const chunks: TtsAudioChunk[] = [];
    for await (const chunk of session.speak({ utteranceId: 'u2', text: segments(['مرحبا']), signal: new AbortController().signal })) chunks.push(chunk);
    expect(provider.connections).toHaveLength(2);
    expect(chunks.length).toBeGreaterThan(0);
    await session.close();
  });

  it('rejects models the multi-context API does not support, and maps handshake auth errors', async () => {
    expect(() => new ElevenLabsTts({ apiKey: 'k', baseUrl: 'http://x', model: 'eleven_v3', voiceId: 'v', zeroRetention: false })).toThrow(ConfigError);
    const provider = await startProvider({ rejectStatus: 403 });
    const error = await ttsOptions(provider.baseUrl).open({ format: pcm16(16000), log: silentLogger }).catch((e: unknown) => e);
    expect(error).toMatchObject({ provider: 'elevenlabs-tts', kind: 'auth' });
  });
});
