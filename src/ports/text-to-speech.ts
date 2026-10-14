import type { AudioFormat } from '../core/audio.js';
import type { Logger } from '../core/logger.js';

export interface TtsAudioChunk {
  /** Audio in the format requested when the session was opened. */
  data: Uint8Array;
  /** Characters this chunk speaks, when the provider reports alignment. */
  text?: string;
}

export interface TtsSpeakOptions {
  utteranceId: string;
  /** Text segments; consumed concurrently while audio is produced. */
  text: AsyncIterable<string>;
  /** Aborting must cancel generation at the provider and end the audio iterator promptly. */
  signal: AbortSignal;
}

/** A long-lived TTS connection reused across utterances of one voice session. */
export interface TtsSession {
  speak(options: TtsSpeakOptions): AsyncIterable<TtsAudioChunk>;
  close(): Promise<void>;
}

export interface TextToSpeech {
  readonly name: string;
  open(options: { format: AudioFormat; log: Logger }): Promise<TtsSession>;
}
