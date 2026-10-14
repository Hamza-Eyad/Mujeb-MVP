import WebSocket from 'ws';
import { z } from 'zod';
import { AsyncQueue, abortReason, raceAbort } from '../../core/async.js';
import type { AudioFormat } from '../../core/audio.js';
import { ConfigError, ProviderError } from '../../core/errors.js';
import type { Logger } from '../../core/logger.js';
import type { TextToSpeech, TtsAudioChunk, TtsSession, TtsSpeakOptions } from '../../ports/text-to-speech.js';
import { decodeBase64, elevenLabsFormat, handshakeError, websocketUrl } from './common.js';
import { describeValue } from '../../core/format.js';

/**
 * ElevenLabs multi-context TTS WebSocket: one connection per voice session, one context per
 * assistant utterance. Docs: https://elevenlabs.io/docs/eleven-api/guides/how-to/websockets/multi-context-web-socket
 *
 * Cancellation does not rely on `close_context` alone: the context is closed at the provider,
 * its queue is failed locally, and any late audio for a closed context is dropped by id.
 */

export interface ElevenLabsTtsOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
  voiceId: string;
  zeroRetention: boolean;
  connectTimeoutMs?: number;
  /** Connection inactivity timeout in seconds (provider max 180). */
  inactivityTimeoutS?: number;
  /** Ends an utterance if the provider sends nothing for this long after the context was closed. */
  finalTimeoutMs?: number;
}

const PROVIDER = 'elevenlabs-tts';

const alignmentSchema = z.looseObject({ chars: z.array(z.string()).optional() }).nullish();
const serverMessageSchema = z.looseObject({
  audio: z.string().nullish(),
  contextId: z.string().optional(),
  context_id: z.string().optional(),
  isFinal: z.boolean().nullish(),
  is_final: z.boolean().nullish(),
  alignment: alignmentSchema,
  normalizedAlignment: alignmentSchema,
  error: z.unknown().optional(),
  message: z.string().optional(),
});

export class ElevenLabsTts implements TextToSpeech {
  readonly name = PROVIDER;
  private readonly options: ElevenLabsTtsOptions;

  constructor(options: ElevenLabsTtsOptions) {
    // The provider documents that multi-context WebSockets are not available for eleven_v3.
    if (options.model === 'eleven_v3') {
      throw new ConfigError('MUJEEB_TTS_MODEL=eleven_v3 is not supported by the ElevenLabs multi-context WebSocket');
    }
    this.options = options;
  }

  async open({ format, log }: { format: AudioFormat; log: Logger }): Promise<TtsSession> {
    const session = new ElevenLabsTtsSession(this.options, elevenLabsFormat(format), log);
    await session.connect();
    return session;
  }
}

interface ContextState {
  queue: AsyncQueue<TtsAudioChunk>;
  closedAtProvider: boolean;
  textSent: number;
  audioChunks: number;
  finalTimer?: NodeJS.Timeout;
}

class ElevenLabsTtsSession implements TtsSession {
  private readonly options: ElevenLabsTtsOptions;
  private readonly outputFormat: string;
  private readonly log: Logger;
  private ws: WebSocket | undefined;
  private connecting: Promise<WebSocket> | undefined;
  private readonly contexts = new Map<string, ContextState>();
  private readonly closedContexts = new Set<string>();
  private lateChunksDropped = 0;
  private closed = false;

  constructor(options: ElevenLabsTtsOptions, outputFormat: string, log: Logger) {
    this.options = options;
    this.outputFormat = outputFormat;
    this.log = log;
  }

  connect(): Promise<WebSocket> {
    if (this.ws?.readyState === WebSocket.OPEN) return Promise.resolve(this.ws);
    this.connecting ??= this.openSocket().finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  async *speak({ utteranceId, text, signal }: TtsSpeakOptions): AsyncGenerator<TtsAudioChunk> {
    const ws = await raceAbort(this.connect(), signal);
    const contextId = utteranceId;
    const state: ContextState = { queue: new AsyncQueue<TtsAudioChunk>(), closedAtProvider: false, textSent: 0, audioChunks: 0 };
    this.contexts.set(contextId, state);

    const closeContext = (): void => {
      if (state.closedAtProvider) return;
      state.closedAtProvider = true;
      this.send(ws, { context_id: contextId, close_context: true });
    };
    const onAbort = (): void => {
      closeContext();
      state.queue.fail(abortReason(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });

    const pump = async (): Promise<void> => {
      let sent = 0;
      try {
        for await (const segment of text) {
          if (signal.aborted) return;
          this.send(ws, { text: segment.endsWith(' ') ? segment : `${segment} `, context_id: contextId, flush: true });
          sent += 1;
          state.textSent = sent;
        }
        if (signal.aborted) return;
        if (sent === 0) {
          state.queue.end();
          return;
        }
        this.send(ws, { context_id: contextId, flush: true });
        closeContext();
        this.armFinalTimer(contextId, state);
      } catch (err) {
        closeContext();
        state.queue.fail(err);
      }
    };
    void pump();

    try {
      for await (const chunk of state.queue) {
        if (signal.aborted) throw abortReason(signal);
        yield chunk;
      }
    } finally {
      signal.removeEventListener('abort', onAbort);
      closeContext(); // also covers a consumer that stops reading early
      clearTimeout(state.finalTimer);
      this.contexts.delete(contextId);
      this.closedContexts.add(contextId);
      if (this.closedContexts.size > 64) this.closedContexts.delete(this.closedContexts.values().next().value ?? '');
    }
  }

  close(): Promise<void> {
    this.closed = true;
    const ws = this.ws;
    for (const state of this.contexts.values()) state.queue.fail(new ProviderError(PROVIDER, 'unavailable', 'TTS session closed'));
    if (!ws || ws.readyState === WebSocket.CLOSED) return Promise.resolve();
    this.send(ws, { close_socket: true });
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        ws.terminate();
        resolve();
      }, 1000);
      ws.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
      ws.close(1000, 'session_end');
    });
  }

  private openSocket(): Promise<WebSocket> {
    const o = this.options;
    const url = websocketUrl(o.baseUrl, `/v1/text-to-speech/${encodeURIComponent(o.voiceId)}/multi-stream-input`, {
      model_id: o.model,
      output_format: this.outputFormat,
      inactivity_timeout: String(o.inactivityTimeoutS ?? 180),
      sync_alignment: 'true',
      auto_mode: 'true',
      enable_logging: o.zeroRetention ? 'false' : undefined,
    });
    const ws = new WebSocket(url, { headers: { 'xi-api-key': o.apiKey }, handshakeTimeout: o.connectTimeoutMs ?? 5000 });
    return new Promise<WebSocket>((resolve, reject) => {
      let settled = false;
      ws.once('unexpected-response', (_req, res) => {
        settled = true;
        ws.terminate();
        reject(handshakeError(PROVIDER, res));
      });
      ws.once('error', (err) => {
        if (settled) return;
        settled = true;
        reject(new ProviderError(PROVIDER, 'unavailable', `Connection failed: ${err.message}`, { cause: err }));
      });
      ws.once('open', () => {
        settled = true;
        this.ws = ws;
        ws.on('message', (data) => this.onMessage(data));
        ws.on('error', (err) => this.log.warn('tts.ws_error', { message: err.message }));
        ws.on('close', (code, reason) => this.onClose(ws, code, reason.toString()));
        this.log.info('tts.connected', { model: o.model, output_format: this.outputFormat, zero_retention_requested: o.zeroRetention });
        resolve(ws);
      });
    });
  }

  private onMessage(data: WebSocket.RawData): void {
    let msg: z.infer<typeof serverMessageSchema>;
    try {
      msg = serverMessageSchema.parse(JSON.parse(rawToString(data)));
    } catch {
      this.log.warn('tts.unparseable_message');
      return;
    }
    const contextId = msg.contextId ?? msg.context_id;
    if (msg.error !== undefined && msg.error !== null) {
      const error = new ProviderError(PROVIDER, classify(msg), `Provider error: ${msg.message ?? describeValue(msg.error)}`);
      this.log.warn('tts.provider_error', { kind: error.kind, context_id: contextId });
      const targets = contextId ? [this.contexts.get(contextId)] : [...this.contexts.values()];
      for (const state of targets) state?.queue.fail(error);
      return;
    }
    if (contextId === undefined) return;
    const state = this.contexts.get(contextId);
    if (!state) {
      if (this.closedContexts.has(contextId)) this.lateChunksDropped += 1; // late audio of a cancelled utterance
      return;
    }
    if (msg.audio) {
      const chars = msg.alignment?.chars ?? msg.normalizedAlignment?.chars;
      state.audioChunks += 1;
      state.queue.push(chars ? { data: decodeBase64(msg.audio), text: chars.join('') } : { data: decodeBase64(msg.audio) });
      if (state.closedAtProvider) this.armFinalTimer(contextId, state);
    }
    if (msg.isFinal === true || msg.is_final === true) {
      // Observed: the server sends isFinal after every flush, not only after close_context.
      // The utterance ends only once all text was sent and the context was closed.
      if (!state.closedAtProvider) return;
      if (state.textSent > 0 && state.audioChunks === 0) {
        // The WebSocket ends a rejected request silently (observed: library voice on a free plan).
        this.log.warn('tts.final_without_audio', { context_id: contextId });
        state.queue.fail(
          new ProviderError(PROVIDER, 'bad_request', 'TTS finished without audio — the voice/model may not be available to this API key or plan (run npm run probe:elevenlabs)', { retryable: false }),
        );
        return;
      }
      state.queue.end();
    }
  }

  /** Guard against a missing final message: end the utterance after a quiet period. */
  private armFinalTimer(contextId: string, state: ContextState): void {
    clearTimeout(state.finalTimer);
    state.finalTimer = setTimeout(() => {
      if (!state.queue.isClosed) {
        this.log.warn('tts.final_timeout', { context_id: contextId });
        state.queue.end();
      }
    }, this.options.finalTimeoutMs ?? 3000);
    state.finalTimer.unref();
  }

  private onClose(ws: WebSocket, code: number, reason: string): void {
    if (this.ws === ws) this.ws = undefined; // reconnect lazily on the next utterance
    if (this.lateChunksDropped > 0) this.log.info('tts.late_chunks_dropped', { count: this.lateChunksDropped });
    if (this.closed) return;
    this.log.info('tts.disconnected', { code, reason });
    const error = new ProviderError(PROVIDER, code === 1008 ? 'auth' : 'unavailable', `Connection closed (${code}${reason ? `: ${reason}` : ''})`);
    for (const state of this.contexts.values()) state.queue.fail(error);
  }

  private send(ws: WebSocket, message: Record<string, unknown>): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
  }
}

function classify(msg: { message?: string | undefined; error?: unknown }): ProviderError['kind'] {
  const text = `${msg.message ?? ''} ${typeof msg.error === 'string' ? msg.error : ''}`.toLowerCase();
  if (text.includes('quota')) return 'quota';
  if (text.includes('auth') || text.includes('api key') || text.includes('unauthorized')) return 'auth';
  if (text.includes('rate')) return 'rate_limit';
  return 'bad_request';
}

function rawToString(data: WebSocket.RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return data.toString('utf8');
}
