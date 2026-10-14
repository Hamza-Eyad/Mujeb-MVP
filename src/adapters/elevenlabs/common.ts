import type { IncomingMessage } from 'node:http';
import type { AudioFormat } from '../../core/audio.js';
import { ConfigError, ProviderError, type ProviderErrorKind } from '../../core/errors.js';

const PCM_RATES = new Set([8000, 16000, 22050, 24000, 44100, 48000]);

/** ElevenLabs audio format id (`pcm_16000`, `ulaw_8000`, …) for a Mujeeb AudioFormat. */
export function elevenLabsFormat(format: AudioFormat): string {
  if (format.encoding === 'pcm_s16le' && PCM_RATES.has(format.sampleRate)) return `pcm_${format.sampleRate}`;
  if (format.encoding === 'mulaw' && format.sampleRate === 8000) return 'ulaw_8000';
  throw new ConfigError(`ElevenLabs does not support audio format ${format.encoding}@${format.sampleRate}`);
}

export function websocketUrl(baseUrl: string, path: string, params: Record<string, string | undefined>): URL {
  const url = new URL(path, baseUrl);
  url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:';
  for (const [key, value] of Object.entries(params)) if (value !== undefined) url.searchParams.set(key, value);
  return url;
}

export function handshakeError(provider: string, res: IncomingMessage): ProviderError {
  const status = res.statusCode ?? 0;
  let kind: ProviderErrorKind = 'unknown';
  if (status === 401 || status === 403) kind = 'auth';
  else if (status === 429) kind = 'rate_limit';
  else if (status === 402) kind = 'quota';
  else if (status >= 400 && status < 500) kind = 'bad_request';
  else if (status >= 500) kind = 'unavailable';
  return new ProviderError(provider, kind, `WebSocket handshake rejected (HTTP ${status})`);
}

export function decodeBase64(value: string): Uint8Array {
  const buf = Buffer.from(value, 'base64');
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}
