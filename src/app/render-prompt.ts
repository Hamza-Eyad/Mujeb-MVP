import { type AudioFormat, concatBytes } from '../core/audio.js';
import type { Logger } from '../core/logger.js';
import type { TextToSpeech } from '../ports/text-to-speech.js';

/**
 * Renders a fixed prompt (the telephony "unavailable" apology) once, in a clinic's voice, through the
 * TextToSpeech port. The result is raw PCM in `format`: Asterisk plays it from a file, so nothing is
 * synthesized per call, and the prompt still plays when Mujeeb itself is down.
 */
export async function renderPrompt(tts: TextToSpeech, text: string, options: { format: AudioFormat; log: Logger; timeoutMs: number }): Promise<Uint8Array> {
  if (text.trim() === '') throw new Error('The prompt text is empty');
  const session = await tts.open({ format: options.format, log: options.log });
  const signal = AbortSignal.timeout(options.timeoutMs);
  const chunks: Uint8Array[] = [];
  try {
    for await (const chunk of session.speak({ utteranceId: 'prompt', text: single(text.trim()), signal })) chunks.push(chunk.data);
  } finally {
    await session.close();
  }
  if (signal.aborted) throw new Error(`TTS did not finish the prompt within ${options.timeoutMs}ms`);
  const audio = concatBytes(chunks);
  if (audio.byteLength === 0) throw new Error('TTS returned no audio for the prompt');
  return audio;
}

async function* single(text: string): AsyncGenerator<string> {
  await Promise.resolve();
  yield text;
}
