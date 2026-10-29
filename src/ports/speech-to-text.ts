import type { AudioFormat } from '../core/audio.js';
import type { ProviderError } from '../core/errors.js';
import type { Logger } from '../core/logger.js';

export type SttEvent =
  /** Provider accepted the session. `effective` echoes the settings the provider says it applied. */
  | { type: 'ready'; effective: Record<string, unknown> }
  | { type: 'partial'; text: string }
  | { type: 'committed'; text: string }
  /** Non-fatal provider warning/error; the stream stays open. */
  | { type: 'warning'; error: ProviderError }
  /** Stream ended. `error` is set when it ended unexpectedly. */
  | { type: 'closed'; error?: ProviderError };

export interface SttStream {
  sendAudio(data: Uint8Array): void;
  close(): Promise<void>;
}

export interface SttOpenOptions {
  format: AudioFormat;
  onEvent: (event: SttEvent) => void;
  /**
   * Cancels the opening: when it aborts before the stream is open, open() rejects and releases its
   * connection (the socket is closed, not left to finish). It does not affect a stream already open.
   */
  signal: AbortSignal;
  log: Logger;
}

export interface SpeechToText {
  readonly name: string;
  open(options: SttOpenOptions): Promise<SttStream>;
}
