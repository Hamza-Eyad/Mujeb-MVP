import { sleep } from '../../core/async.js';
import { type AudioFormat, bytesForDuration } from '../../core/audio.js';
import { ConfigError, type ProviderError } from '../../core/errors.js';
import type { TextToSpeech, TtsAudioChunk, TtsSession, TtsSpeakOptions } from '../../ports/text-to-speech.js';

/**
 * Fake TTS: a soft tone whose length follows the text, emitted in chunks with alignment text.
 * `ignoreAbort` simulates a provider that keeps sending audio after cancellation, to prove the
 * session never forwards stale audio.
 */

export interface FakeTtsOptions {
  msPerChar?: number;
  chunkMs?: number;
  /** Generation speed: wall-clock ms per audio ms (0.1 = 10× faster than real time). */
  realtimeFactor?: number;
  firstAudioDelayMs?: number;
  withAlignment?: boolean;
  ignoreAbort?: boolean;
  failOpen?: ProviderError;
  /** With failOpen: only the first N open() calls fail (default: all). */
  failOpenTimes?: number;
  /** Never produce audio (until aborted) — for timeout tests. */
  hang?: boolean;
}

export interface FakeUtteranceRecord {
  id: string;
  segments: string[];
  chunks: number;
  cancelled: boolean;
}

export class FakeTextToSpeech implements TextToSpeech {
  readonly name = 'fake-tts';
  readonly utterances: FakeUtteranceRecord[] = [];
  opened = 0;
  closed = 0;
  private readonly options: FakeTtsOptions;
  private openFailuresLeft: number;

  constructor(options: FakeTtsOptions = {}) {
    this.options = options;
    this.openFailuresLeft = options.failOpenTimes ?? Number.POSITIVE_INFINITY;
  }

  open({ format }: { format: AudioFormat }): Promise<TtsSession> {
    if (this.options.failOpen && this.openFailuresLeft > 0) {
      this.openFailuresLeft -= 1;
      return Promise.reject(this.options.failOpen);
    }
    if (format.encoding !== 'pcm_s16le') return Promise.reject(new ConfigError('fake TTS produces PCM16 only'));
    this.opened += 1;
    return Promise.resolve({
      speak: (speakOptions) => this.speak(format, speakOptions),
      close: () => {
        this.closed += 1;
        return Promise.resolve();
      },
    });
  }

  private async *speak(format: AudioFormat, { utteranceId, text, signal }: TtsSpeakOptions): AsyncGenerator<TtsAudioChunk> {
    const record: FakeUtteranceRecord = { id: utteranceId, segments: [], chunks: 0, cancelled: false };
    this.utterances.push(record);
    const o = this.options;
    const chunkMs = o.chunkMs ?? 100;
    const wait = (ms: number): Promise<void> => sleep(ms, o.ignoreAbort ? undefined : signal);
    let phase = 0;
    let first = true;
    try {
      for await (const segment of text) {
        record.segments.push(segment);
        if (o.hang) await sleep(60 * 60 * 1000, signal);
        const totalMs = Math.max(chunkMs, segment.length * (o.msPerChar ?? 60));
        const count = Math.ceil(totalMs / chunkMs);
        for (let i = 0; i < count; i += 1) {
          await wait(first ? (o.firstAudioDelayMs ?? 40) : chunkMs * (o.realtimeFactor ?? 0.1));
          first = false;
          const from = Math.round((i * segment.length) / count);
          const to = Math.round(((i + 1) * segment.length) / count);
          const aligned = segment.slice(from, to) + (i === count - 1 ? ' ' : '');
          const { data, nextPhase } = tone(chunkMs, format, phase);
          phase = nextPhase;
          record.chunks += 1;
          yield o.withAlignment === false ? { data } : { data, text: aligned };
        }
      }
    } finally {
      if (signal.aborted) record.cancelled = true;
    }
  }
}

function tone(ms: number, format: AudioFormat, phase: number): { data: Uint8Array; nextPhase: number } {
  const bytes = bytesForDuration(ms, format);
  const samples = new Int16Array(bytes / 2);
  const step = (2 * Math.PI * 220) / format.sampleRate;
  let p = phase;
  for (let i = 0; i < samples.length; i += 1) {
    samples[i] = Math.round(2500 * Math.sin(p));
    p += step;
  }
  return { data: new Uint8Array(samples.buffer), nextPhase: p % (2 * Math.PI) };
}
