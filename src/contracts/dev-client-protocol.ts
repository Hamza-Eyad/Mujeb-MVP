import { z } from 'zod';

/**
 * Wire protocol between the local browser test client (web/dev-client) and the engine.
 * The browser is a thin audio transport + display: it never holds keys or conversation logic.
 *
 * Binary client → server: raw PCM16LE mono frames in the session's input format.
 * Binary server → client: 4-byte little-endian uint32 epoch header + PCM16LE audio.
 */

export const AUDIO_EPOCH_HEADER_BYTES = 4;
export const MAX_CLIENT_AUDIO_FRAME_BYTES = 32_000; // 1s of 16kHz PCM16 — far above the 20ms frames we expect

const epoch = z.number().int().nonnegative();

export const clientMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('hello'),
    userAgent: z.string().max(300).optional(),
    playbackRoute: z.enum(['direct', 'webrtc-loopback']).optional(),
    audioConstraints: z
      .object({ echoCancellation: z.boolean(), noiseSuppression: z.boolean(), autoGainControl: z.boolean() })
      .partial()
      .optional(),
    contextSampleRate: z.number().int().positive().optional(),
  }),
  z.object({ type: z.literal('mark'), name: z.string().min(1).max(64) }),
  z.object({ type: z.literal('playback_started'), epoch }),
  z.object({ type: z.literal('playback_cleared'), epoch }),
  z.object({ type: z.literal('pong'), id: z.number().int().nonnegative() }),
]);

export type ClientMessage = z.infer<typeof clientMessageSchema>;

export type ServerMessage =
  | {
      type: 'session_started';
      sessionId: string;
      inputFormat: { encoding: string; sampleRate: number };
      outputFormat: { encoding: string; sampleRate: number };
      providers: { stt: string; llm: string; tts: string };
      /** Safe-to-display configuration (provider/model choices, voice behaviour) — never secrets. */
      config?: Record<string, unknown>;
      notice: string;
    }
  | { type: 'mark'; name: string }
  | { type: 'clear'; epoch: number }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'ping'; id: number }
  | { type: 'event'; event: unknown }
  | { type: 'error'; message: string };
