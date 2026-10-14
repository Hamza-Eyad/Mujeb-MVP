import { ElevenLabsTts } from '../adapters/elevenlabs/multi-context-tts.js';
import { ElevenLabsRealtimeStt, interpretSessionConfig } from '../adapters/elevenlabs/realtime-stt.js';
import type { Settings } from '../config/settings.js';
import { pcm16 } from '../core/audio.js';
import { ConfigError, errorSummary } from '../core/errors.js';
import type { Logger } from '../core/logger.js';
import type { SttEvent } from '../ports/speech-to-text.js';
import { describeValue } from '../core/format.js';

/**
 * Verifies — against the real account — what the docs leave open:
 *  1. does the STT server apply `turn_prediction` for the configured model?
 *  2. does it apply zero retention (`enable_logging=false`, Enterprise-only)?
 *  3. do the configured TTS model/voice work, and how fast is first audio?
 *  4. TTS → STT round trip in Arabic (pipeline sanity, not a dialect benchmark).
 * Evidence comes from what the server echoes in `session_started.config`.
 */

export type Applied = boolean | 'unknown';

export interface SttProbeCase {
  requested: { commit_strategy: 'vad' | 'turn_prediction'; zero_retention: boolean };
  outcome: 'accepted' | 'rejected' | 'timeout';
  connect_ms?: number;
  effective?: Record<string, unknown>;
  applied?: { commit_strategy: Applied; zero_retention?: Applied };
  error?: string;
  /** Explicit provider reason fetched over HTTP when the WebSocket only says "not authenticated". */
  diagnosis?: string;
}

export interface ProbeResult {
  timestamp: string;
  stt_model?: string;
  tts_model?: string;
  stt: SttProbeCase[];
  tts?: { outcome: 'ok' | 'error'; first_audio_ms?: number; audio_ms?: number; alignment?: boolean; error?: string; diagnosis?: string };
  roundtrip?: { outcome: 'ok' | 'no_transcript' | 'error'; sent_text: string; transcript?: string; error?: string };
}

const PROBE_TEXT = 'مرحبا، هذا اختبار قصير من مُجيب للتأكد من جودة الصوت.';
const FORMAT = pcm16(16000);

export async function runElevenLabsProbe(settings: Settings, log: Logger, options: { timeoutMs?: number } = {}): Promise<ProbeResult> {
  const apiKey = settings.elevenlabs.apiKey;
  const sttModel = settings.stt.model;
  if (!apiKey || !sttModel) throw new ConfigError('Probe needs ELEVENLABS_API_KEY and MUJEEB_STT_MODEL');
  const timeoutMs = options.timeoutMs ?? 8000;
  const result: ProbeResult = { timestamp: new Date().toISOString(), stt_model: sttModel, stt: [] };

  const makeStt = (commitStrategy: 'vad' | 'turn_prediction', zeroRetention: boolean) =>
    new ElevenLabsRealtimeStt({ apiKey, baseUrl: settings.elevenlabs.baseUrl, model: sttModel, languageCode: settings.stt.languageCode, commitStrategy, vadSilenceSecs: settings.stt.vadSilenceSecs, zeroRetention });

  const cases: Array<[commit: 'vad' | 'turn_prediction', zr: boolean]> = [['vad', false], ['turn_prediction', false], ['vad', true]];
  for (const [commit, zr] of cases) {
    result.stt.push(await probeSttCase(makeStt(commit, zr), commit, zr, log, timeoutMs));
  }
  if (result.stt.some((c) => c.error?.startsWith('auth_error'))) {
    // The WebSocket only says 'not authenticated'; the token endpoint names the missing permission.
    const diagnosis = await httpDiagnosis(`${settings.elevenlabs.baseUrl}/v1/single-use-token/realtime_scribe`, { method: 'POST', headers: { 'xi-api-key': apiKey } });
    for (const c of result.stt) if (c.error?.startsWith('auth_error')) c.diagnosis = diagnosis;
  }

  if (settings.tts.model && settings.tts.voiceId) {
    result.tts_model = settings.tts.model;
    const tts = new ElevenLabsTts({ apiKey, baseUrl: settings.elevenlabs.baseUrl, model: settings.tts.model, voiceId: settings.tts.voiceId, zeroRetention: settings.elevenlabs.zeroRetention });
    const audio: Uint8Array[] = [];
    let session: Awaited<ReturnType<ElevenLabsTts['open']>> | undefined;
    try {
      const started = performance.now();
      let firstAudio: number | undefined;
      let alignment = false;
      session = await tts.open({ format: FORMAT, log });
      const signal = AbortSignal.timeout(timeoutMs * 2);
      for await (const chunk of session.speak({ utteranceId: 'probe', text: once(PROBE_TEXT), signal })) {
        firstAudio ??= performance.now() - started;
        alignment ||= chunk.text !== undefined;
        audio.push(chunk.data);
      }
      const bytes = audio.reduce((n, a) => n + a.byteLength, 0);
      result.tts = { outcome: 'ok', ...(firstAudio !== undefined ? { first_audio_ms: Math.round(firstAudio) } : {}), audio_ms: Math.round(bytes / 32), alignment };
    } catch (err) {
      result.tts = { outcome: 'error', error: errorSummary(err).message };
    } finally {
      await session?.close(); // always release the socket, or the process waits for the provider's idle timeout
    }
    if (result.tts.outcome === 'ok' && audio.length === 0) result.tts = { outcome: 'error', error: 'No audio received' };
    if (result.tts.outcome === 'error') {
      // The multi-context WebSocket can end silently; the HTTP endpoint returns the explicit reason.
      result.tts.diagnosis = await httpDiagnosis(`${settings.elevenlabs.baseUrl}/v1/text-to-speech/${encodeURIComponent(settings.tts.voiceId)}?output_format=pcm_16000`, {
        method: 'POST',
        headers: { 'xi-api-key': apiKey, 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'مرحبا', model_id: settings.tts.model }),
      });
    }
    if (audio.length > 0) result.roundtrip = await roundTrip(makeStt('vad', settings.elevenlabs.zeroRetention), audio, log, timeoutMs);
  }
  return result;
}

async function probeSttCase(stt: ElevenLabsRealtimeStt, commit: 'vad' | 'turn_prediction', zr: boolean, log: Logger, timeoutMs: number): Promise<SttProbeCase> {
  const requested = { commit_strategy: commit, zero_retention: zr };
  const started = performance.now();
  let resolveEvent: (e: SttEvent) => void = () => {};
  const firstEvent = new Promise<SttEvent>((resolve) => (resolveEvent = resolve));
  try {
    const stream = await stt.open({ format: FORMAT, onEvent: (e) => resolveEvent(e), signal: AbortSignal.timeout(timeoutMs), log });
    const event = await Promise.race([firstEvent, delay(timeoutMs).then(() => undefined)]);
    await stream.close();
    if (event === undefined) return { requested, outcome: 'timeout' };
    if (event.type !== 'ready') {
      const message = event.type === 'closed' || event.type === 'warning' ? event.error?.message : event.type;
      return { requested, outcome: 'rejected', ...(message !== undefined ? { error: message } : {}) };
    }
    const effective = event.effective;
    const interpreted = interpretSessionConfig(effective);
    return {
      requested,
      outcome: 'accepted',
      connect_ms: Math.round(performance.now() - started),
      effective,
      applied: {
        commit_strategy: applied(interpreted.commitStrategy, commit),
        ...(zr ? { zero_retention: applied(interpreted.zeroRetention, true) } : {}),
      },
    };
  } catch (err) {
    return { requested, outcome: 'rejected', error: errorSummary(err).message };
  }
}

async function roundTrip(stt: ElevenLabsRealtimeStt, audio: Uint8Array[], log: Logger, timeoutMs: number): Promise<ProbeResult['roundtrip']> {
  const committed: string[] = [];
  try {
    const stream = await stt.open({
      format: FORMAT,
      onEvent: (e) => {
        if (e.type === 'committed' && e.text.trim() !== '') committed.push(e.text.trim());
      },
      signal: AbortSignal.timeout(timeoutMs),
      log,
    });
    const all = Buffer.concat(audio.map((a) => Buffer.from(a.buffer, a.byteOffset, a.byteLength)));
    const chunk = 3200; // 100ms
    for (let i = 0; i < all.length; i += chunk) {
      stream.sendAudio(new Uint8Array(all.subarray(i, i + chunk)));
      await delay(25);
    }
    for (let i = 0; i < 20; i += 1) {
      stream.sendAudio(new Uint8Array(chunk)); // 2s of silence → VAD commit
      await delay(25);
    }
    const deadline = Date.now() + timeoutMs;
    while (committed.length === 0 && Date.now() < deadline) await delay(50);
    await stream.close();
    if (committed.length === 0) return { outcome: 'no_transcript', sent_text: PROBE_TEXT };
    return { outcome: 'ok', sent_text: PROBE_TEXT, transcript: committed.join(' ') };
  } catch (err) {
    return { outcome: 'error', sent_text: PROBE_TEXT, error: errorSummary(err).message };
  }
}

/** Status + the provider's own message, without echoing tokens or audio. */
async function httpDiagnosis(url: string, init: RequestInit): Promise<string> {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
    if (res.ok) return `HTTP ${res.status} OK`;
    const body = (await res.json().catch(() => null)) as { detail?: unknown } | null;
    const detail = body?.detail;
    const message = typeof detail === 'string' ? detail : describeValue((detail as { message?: unknown } | undefined)?.message ?? body);
    return `HTTP ${res.status}: ${message.slice(0, 300)}`;
  } catch (err) {
    return `diagnosis failed: ${errorSummary(err).message}`;
  }
}

function applied<T>(effective: T | undefined, wanted: T): Applied {
  return effective === undefined ? 'unknown' : effective === wanted;
}

async function* once(text: string): AsyncGenerator<string> {
  await Promise.resolve();
  yield text;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
