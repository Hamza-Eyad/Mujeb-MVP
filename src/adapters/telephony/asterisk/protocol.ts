import { z } from 'zod';

/**
 * Asterisk chan_websocket control protocol, JSON form (dial option `f(json)`, Asterisk ≥ 22.8 / 20.18 / 23.2).
 * Media travels in BINARY frames; commands and events are one JSON object per TEXT frame.
 * Reference: docs.asterisk.org → Configuration → Channel Drivers → WebSocket.
 * Behaviour relied on here was checked in the local lab (plans/2026-10-25-phase-4-call-connection.md).
 */

export type AsteriskCommand =
  | { command: 'ANSWER' }
  | { command: 'HANGUP' }
  | { command: 'MARK_MEDIA'; correlation_id: string }
  | { command: 'FLUSH_MEDIA' }
  | { command: 'PAUSE_MEDIA' }
  | { command: 'CONTINUE_MEDIA' }
  | { command: 'GET_STATUS' };

const mediaStartSchema = z.object({
  event: z.literal('MEDIA_START'),
  channel_id: z.string().min(1),
  format: z.string().min(1),
  optimal_frame_size: z.coerce.number().int().positive(),
  channel_variables: z.record(z.string(), z.unknown()).optional(),
});
const markProcessedSchema = z.object({ event: z.literal('MEDIA_MARK_PROCESSED'), correlation_id: z.string() });
const statusSchema = z.object({
  event: z.literal('STATUS'),
  queue_length: z.coerce.number().int().min(0),
  xon_level: z.coerce.number().int().min(0).optional(),
});

export type MediaStart = z.infer<typeof mediaStartSchema>;

export type AsteriskEvent =
  | MediaStart
  | z.infer<typeof markProcessedSchema>
  | z.infer<typeof statusSchema>
  | { event: 'MEDIA_XOFF' }
  | { event: 'MEDIA_XON' }
  | { event: 'DTMF_END' }
  | { event: 'OTHER'; name: string };

/** One TEXT frame → event. Undefined for anything that is not a well-formed event of a known shape. */
export function parseAsteriskEvent(text: string): AsteriskEvent | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof raw !== 'object' || raw === null) return undefined;
  const name = (raw as { event?: unknown }).event;
  if (typeof name !== 'string') return undefined;
  switch (name) {
    case 'MEDIA_START':
      return mediaStartSchema.safeParse(raw).data;
    case 'MEDIA_MARK_PROCESSED':
      return markProcessedSchema.safeParse(raw).data;
    case 'STATUS':
      return statusSchema.safeParse(raw).data;
    case 'MEDIA_XOFF':
    case 'MEDIA_XON':
    case 'DTMF_END':
      return { event: name };
    default:
      return { event: 'OTHER', name };
  }
}

/**
 * Channel variables as chan_websocket reports them. Variables set with Asterisk's inheritance prefix
 * (`__NAME` or `_NAME`) keep the prefix in MEDIA_START; it is stripped here.
 */
export function channelVariables(start: MediaStart): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(start.channel_variables ?? {})) {
    if (typeof value === 'string') out[key.replace(/^_{1,2}/, '')] = value;
  }
  return out;
}
