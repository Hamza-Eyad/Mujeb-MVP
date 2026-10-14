import { pcm16Samples } from '../../core/audio.js';
import { ConfigError, type ProviderError } from '../../core/errors.js';
import type { SpeechToText, SttEvent, SttOpenOptions, SttStream } from '../../ports/speech-to-text.js';

/**
 * Fake STT with two modes:
 * - `scripted`: tests drive transcripts directly (`partial()`, `commit()`, `drop()`).
 * - `energy`:   for `npm run dev:fake` — loud audio produces progressive partials of a canned
 *               Arabic utterance and a commit after a pause, so the whole loop (including
 *               barge-in) can be exercised in the browser without any paid API.
 */

export interface FakeSttOptions {
  mode: 'scripted' | 'energy';
  utterances?: readonly string[];
  /** Reject the next N open() calls with this error. */
  failOpen?: { times: number; error: ProviderError };
}

const DEFAULT_UTTERANCES = [
  'السلام عليكم ابي اعرف مواعيد الدوام',
  'طيب وهل عندكم عيادة اسنان',
  'كم سعر الكشف تقريبا',
  'شكرا مع السلامة',
];

export class FakeSpeechToText implements SpeechToText {
  readonly name = 'fake-stt';
  readonly streams: FakeSttStream[] = [];
  private readonly options: FakeSttOptions;
  private failuresLeft: number;
  private utteranceIndex = 0;

  constructor(options: FakeSttOptions = { mode: 'scripted' }) {
    this.options = options;
    this.failuresLeft = options.failOpen?.times ?? 0;
  }

  get current(): FakeSttStream | undefined {
    return this.streams[this.streams.length - 1];
  }

  open(options: SttOpenOptions): Promise<SttStream> {
    if (this.failuresLeft > 0 && this.options.failOpen) {
      this.failuresLeft -= 1;
      return Promise.reject(this.options.failOpen.error);
    }
    if (options.format.encoding !== 'pcm_s16le') {
      return Promise.reject(new ConfigError('fake STT supports PCM16 input only'));
    }
    const stream = new FakeSttStream(options, this.options.mode, () => this.nextUtterance());
    this.streams.push(stream);
    queueMicrotask(() => stream.emit({ type: 'ready', effective: { provider: 'fake', mode: this.options.mode } }));
    return Promise.resolve(stream);
  }

  private nextUtterance(): string {
    const list = this.options.utterances ?? DEFAULT_UTTERANCES;
    const text = list[this.utteranceIndex % list.length] ?? '';
    this.utteranceIndex += 1;
    return text;
  }
}

export class FakeSttStream implements SttStream {
  bytesReceived = 0;
  lastChunk: Uint8Array | undefined;
  closed = false;
  private readonly options: SttOpenOptions;
  private readonly mode: FakeSttOptions['mode'];
  private readonly nextUtterance: () => string;
  // energy mode state
  private speechMs = 0;
  private silenceMs = 0;
  private words: string[] = [];
  private wordsShown = 0;

  constructor(options: SttOpenOptions, mode: FakeSttOptions['mode'], nextUtterance: () => string) {
    this.options = options;
    this.mode = mode;
    this.nextUtterance = nextUtterance;
  }

  emit(event: SttEvent): void {
    if (this.closed && event.type !== 'closed') return;
    this.options.onEvent(event);
  }

  sendAudio(data: Uint8Array): void {
    if (this.closed) return;
    this.bytesReceived += data.byteLength;
    this.lastChunk = data;
    if (this.mode === 'energy') this.processEnergy(data);
  }

  partial(text: string): void {
    this.emit({ type: 'partial', text });
  }

  commit(text: string): void {
    this.emit({ type: 'committed', text });
  }

  /** Simulate the provider dropping the connection. */
  drop(error?: ProviderError): void {
    if (this.closed) return;
    this.closed = true;
    this.options.onEvent(error ? { type: 'closed', error } : { type: 'closed' });
  }

  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }

  private processEnergy(data: Uint8Array): void {
    const samples = pcm16Samples(data);
    const ms = (samples.length / this.options.format.sampleRate) * 1000;
    let sum = 0;
    for (const s of samples) sum += s * s;
    const db = 20 * Math.log10(Math.sqrt(sum / Math.max(1, samples.length)) / 32768 + 1e-9);
    if (db > -40) {
      this.silenceMs = 0;
      if (this.words.length === 0) {
        this.words = this.nextUtterance().split(' ');
        this.wordsShown = 0;
      }
      this.speechMs += ms;
      const due = Math.min(this.words.length, Math.floor(this.speechMs / 300) + 1);
      if (due > this.wordsShown) {
        this.wordsShown = due;
        this.partial(this.words.slice(0, due).join(' '));
      }
      return;
    }
    if (this.words.length === 0) return;
    this.silenceMs += ms;
    if (this.silenceMs >= 700) {
      this.commit(this.words.slice(0, Math.max(1, this.wordsShown)).join(' '));
      this.words = [];
      this.wordsShown = 0;
      this.speechMs = 0;
      this.silenceMs = 0;
    }
  }
}
