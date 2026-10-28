import type { AudioFormat } from '../core/audio.js';

/**
 * Where caller audio comes from and where Mujeeb's audio goes. Phase 0: a local browser page.
 * Phase 4: telephony media streams. The voice engine only ever sees this interface.
 *
 * Playback model (same idea as telephony media streams): the far end buffers audio. Mujeeb sends
 * audio tagged with an `epoch` (one per assistant utterance) plus named marks, and learns what was
 * actually played from mark acknowledgements — not from send time.
 */

export interface TransportCapabilities {
  /** Can pause/resume buffered playback without discarding it (browser: yes; most telephony: no). */
  readonly pause: boolean;
  /** Reports when the first sample of an epoch actually starts playing. */
  readonly playbackStartEvents: boolean;
}

export type TransportEvent =
  | { type: 'audio'; data: Uint8Array }
  | { type: 'mark'; name: string }
  | { type: 'playback_started'; epoch: number }
  | { type: 'playback_cleared'; epoch: number }
  | { type: 'rtt'; ms: number }
  | { type: 'closed'; reason: string };

export interface AudioTransport {
  readonly inputFormat: AudioFormat;
  readonly outputFormat: AudioFormat;
  readonly capabilities: TransportCapabilities;
  setHandler(handler: (event: TransportEvent) => void): void;
  sendAudio(epoch: number, data: Uint8Array): void;
  sendMark(epoch: number, name: string): void;
  /** Stop playback now and drop everything buffered for this epoch and older. Also ends a pause(): the next epoch plays. */
  clear(epoch: number): void;
  pause(): void;
  resume(): void;
  close(reason: string): void;
}
