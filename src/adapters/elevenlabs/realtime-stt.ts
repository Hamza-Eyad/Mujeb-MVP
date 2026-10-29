import WebSocket from 'ws';
import { z } from 'zod';
import { abortReason } from '../../core/async.js';
import { ProviderError, type ProviderErrorKind } from '../../core/errors.js';
import type { Logger } from '../../core/logger.js';
import type { SpeechToText, SttEvent, SttOpenOptions, SttStream } from '../../ports/speech-to-text.js';
import { elevenLabsFormat, handshakeError, websocketUrl } from './common.js';

/**
 * ElevenLabs Realtime Speech-to-Text (Scribe realtime) over WebSocket.
 * Docs: https://elevenlabs.io/docs/api-reference/speech-to-text/v-1-speech-to-text-realtime
 *
 * - Audio is sent as `input_audio_chunk` messages (base64) as soon as the session buffers 100ms.
 * - Partials → `partial`, settled segments → `committed` (commit strategy decided by config).
 * - The settings the server says it applied (`session_started.config`) are surfaced as `ready`
 *   and compared to what we requested — that is how `turn_prediction` and zero retention are
 *   verified instead of assumed.
 * - `open()` resolves on `session_started`, within `connectTimeoutMs` from the start of the upgrade.
 *   An open socket alone is not a ready session.
 */

export interface ElevenLabsSttOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
  languageCode: string;
  commitStrategy: 'vad' | 'turn_prediction';
  vadSilenceSecs?: number;
  zeroRetention: boolean;
  connectTimeoutMs?: number;
}

const PROVIDER = 'elevenlabs-stt';

interface SessionStart {
  started(): void;
  failed(error: ProviderError): void;
}

const serverMessageSchema = z.looseObject({
  message_type: z.string(),
  text: z.string().optional(),
  error: z.string().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
});

/** Server error message types → normalized kind and whether the stream can continue. */
const ERROR_TYPES: Record<string, { kind: ProviderErrorKind; fatal: boolean }> = {
  error: { kind: 'unknown', fatal: false },
  auth_error: { kind: 'auth', fatal: true },
  unaccepted_terms: { kind: 'auth', fatal: true },
  quota_exceeded: { kind: 'quota', fatal: true },
  rate_limited: { kind: 'rate_limit', fatal: false },
  resource_exhausted: { kind: 'rate_limit', fatal: false },
  queue_overflow: { kind: 'rate_limit', fatal: false },
  commit_throttled: { kind: 'rate_limit', fatal: false },
  session_time_limit_exceeded: { kind: 'unavailable', fatal: false },
  transcriber_error: { kind: 'unavailable', fatal: false },
  input_error: { kind: 'bad_request', fatal: false },
  invalid_request: { kind: 'bad_request', fatal: false },
  chunk_size_exceeded: { kind: 'bad_request', fatal: false },
  insufficient_audio_activity: { kind: 'bad_request', fatal: false },
};

export class ElevenLabsRealtimeStt implements SpeechToText {
  readonly name = PROVIDER;
  private readonly options: ElevenLabsSttOptions;

  constructor(options: ElevenLabsSttOptions) {
    this.options = options;
  }

  open({ format, onEvent, signal, log }: SttOpenOptions): Promise<SttStream> {
    const o = this.options;
    const audioFormat = elevenLabsFormat(format);
    const requested: Record<string, string | undefined> = {
      model_id: o.model,
      audio_format: audioFormat,
      commit_strategy: o.commitStrategy,
      language_code: o.languageCode,
      vad_silence_threshold_secs: o.vadSilenceSecs?.toString(),
      enable_logging: o.zeroRetention ? 'false' : undefined,
    };
    const url = websocketUrl(o.baseUrl, '/v1/speech-to-text/realtime', requested);
    const timeoutMs = o.connectTimeoutMs ?? 5000;
    const ws = new WebSocket(url, { headers: { 'xi-api-key': o.apiKey }, handshakeTimeout: timeoutMs });
    const stream = new ElevenLabsSttStream(ws, format.sampleRate, onEvent, log, requested);

    // Resolves on `session_started`, not on the open socket: only then does the server transcribe. An error
    // or a close before it rejects, and the stream then emits nothing.
    return new Promise<SttStream>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => fail(new ProviderError(PROVIDER, 'timeout', `Session not started within ${timeoutMs} ms`)), timeoutMs);
      const settle = (): boolean => {
        if (settled) return false;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        return true;
      };
      const fail = (error: Error): void => {
        if (!settle()) return;
        stream.abandon();
        ws.terminate();
        reject(error);
      };
      const onAbort = (): void => fail(abortReason(signal));
      if (signal.aborted) {
        fail(abortReason(signal));
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
      ws.once('unexpected-response', (_req, res) => fail(handshakeError(PROVIDER, res)));
      ws.once('error', (err) => fail(new ProviderError(PROVIDER, 'unavailable', `Connection failed: ${err.message}`, { cause: err })));
      ws.once('open', () => {
        if (settled) return;
        log.info('stt.connected', { model: o.model, audio_format: audioFormat, commit_strategy: o.commitStrategy, zero_retention_requested: o.zeroRetention });
        stream.attach({
          started: () => {
            if (settle()) resolve(stream);
          },
          failed: fail,
        });
      });
    });
  }
}

class ElevenLabsSttStream implements SttStream {
  private readonly ws: WebSocket;
  private readonly sampleRate: number;
  private readonly onEvent: (event: SttEvent) => void;
  private readonly log: Logger;
  private readonly requested: Record<string, string | undefined>;
  private closing = false;
  private fatal: ProviderError | undefined;
  /** Set until `session_started`: reports the start (or a failure before it) back to open(). */
  private starting: SessionStart | undefined;

  constructor(ws: WebSocket, sampleRate: number, onEvent: (event: SttEvent) => void, log: Logger, requested: Record<string, string | undefined>) {
    this.ws = ws;
    this.sampleRate = sampleRate;
    this.onEvent = onEvent;
    this.log = log;
    this.requested = requested;
  }

  attach(starting: SessionStart): void {
    this.starting = starting;
    this.ws.on('message', (data) => this.onMessage(data));
    this.ws.on('error', (err) => this.log.warn('stt.ws_error', { message: err.message }));
    this.ws.on('close', (code, reason) => {
      if (this.closing) return;
      const error = this.fatal ?? new ProviderError(PROVIDER, 'unavailable', `Connection closed (${code}${reason.length > 0 ? `: ${reason.toString()}` : ''})`);
      if (this.failStart(error)) return;
      this.onEvent({ type: 'closed', error });
    });
  }

  /** open() gave up before the session started (timeout, cancel, error): nothing is reported after this. */
  abandon(): void {
    this.closing = true;
    this.starting = undefined;
  }

  /** Before `session_started`, a failure rejects open() instead of becoming a `closed` event. */
  private failStart(error: ProviderError): boolean {
    const starting = this.starting;
    if (!starting) return false;
    this.starting = undefined;
    starting.failed(error);
    return true;
  }

  sendAudio(data: Uint8Array): void {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(
      JSON.stringify({
        message_type: 'input_audio_chunk',
        audio_base_64: Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('base64'),
        commit: false,
        sample_rate: this.sampleRate,
      }),
    );
  }

  close(): Promise<void> {
    this.closing = true;
    if (this.ws.readyState === WebSocket.CLOSED) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.ws.terminate();
        resolve();
      }, 1000);
      this.ws.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
      this.ws.close(1000, 'session_end');
    });
  }

  private onMessage(data: WebSocket.RawData): void {
    let parsed: z.infer<typeof serverMessageSchema>;
    try {
      parsed = serverMessageSchema.parse(JSON.parse(rawToString(data)));
    } catch {
      this.log.warn('stt.unparseable_message');
      return;
    }
    switch (parsed.message_type) {
      case 'session_started': {
        this.checkEffectiveConfig(parsed.config ?? {});
        const starting = this.starting;
        this.starting = undefined;
        starting?.started();
        this.onEvent({ type: 'ready', effective: parsed.config ?? {} });
        return;
      }
      case 'partial_transcript':
        this.onEvent({ type: 'partial', text: parsed.text ?? '' });
        return;
      case 'committed_transcript':
        this.onEvent({ type: 'committed', text: parsed.text ?? '' });
        return;
      case 'committed_transcript_with_timestamps': // duplicate of committed_transcript when timestamps are enabled
      case 'committed_transcript_entities':
      case 'edited_transcript':
        return;
      case 'warning':
        this.onEvent({ type: 'warning', error: new ProviderError(PROVIDER, 'unknown', parsed.error ?? 'warning', { retryable: true }) });
        return;
      default:
        break;
    }
    const mapped = ERROR_TYPES[parsed.message_type];
    if (!mapped) {
      this.log.debug('stt.unknown_message', { message_type: parsed.message_type });
      return;
    }
    const error = new ProviderError(PROVIDER, mapped.kind, `${parsed.message_type}: ${parsed.error ?? ''}`.trim());
    if (mapped.fatal) {
      this.fatal = error; // reported when the server closes the socket
      if (this.failStart(error)) return; // before session_started: open() rejects now and closes the socket
      this.ws.close(1000, 'fatal_error');
      return;
    }
    this.onEvent({ type: 'warning', error });
  }

  /** Verify the provider applied what we asked for (commit strategy, model, zero retention). */
  private checkEffectiveConfig(config: Record<string, unknown>): void {
    const effective = interpretSessionConfig(config);
    const zeroRetentionRequested = this.requested['enable_logging'] === 'false';
    const checks: Array<[string, unknown, unknown]> = [
      ['commit_strategy', this.requested['commit_strategy'], effective.commitStrategy],
      ['model_id', this.requested['model_id'], effective.modelId],
      ['zero_retention', zeroRetentionRequested ? true : undefined, effective.zeroRetention],
    ];
    for (const [key, wanted, got] of checks) {
      if (wanted === undefined || got === undefined) continue;
      if (got !== wanted) this.log.warn('stt.config_mismatch', { key, requested: wanted, effective: got });
    }
    this.log.info('stt.session_started', { effective: config });
  }
}

export interface EffectiveSttSettings {
  commitStrategy?: string;
  modelId?: string;
  zeroRetention?: boolean;
}

/**
 * `session_started.config` as the live API actually sends it. Observed 2026-10-08: the server
 * reports `vad_commit_strategy` (boolean) and `disable_logging` rather than the documented
 * `commit_strategy` / `enable_logging`; both shapes are accepted here.
 */
export function interpretSessionConfig(config: Record<string, unknown>): EffectiveSttSettings {
  const out: EffectiveSttSettings = {};
  const commit = config['commit_strategy'];
  const vadCommit = config['vad_commit_strategy'];
  if (typeof commit === 'string') out.commitStrategy = commit;
  else if (typeof vadCommit === 'boolean') out.commitStrategy = vadCommit ? 'vad' : 'manual';
  if (typeof config['model_id'] === 'string') out.modelId = config['model_id'];
  const enableLogging = config['enable_logging'];
  const disableLogging = config['disable_logging'];
  if (typeof enableLogging === 'boolean') out.zeroRetention = !enableLogging;
  else if (typeof disableLogging === 'boolean') out.zeroRetention = disableLogging;
  return out;
}

function rawToString(data: WebSocket.RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return data.toString('utf8');
}
