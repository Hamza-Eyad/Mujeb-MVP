/** Audio formats and small helpers shared by every layer. No vendor knowledge here. */

export type AudioEncoding = 'pcm_s16le' | 'mulaw';

export interface AudioFormat {
  readonly encoding: AudioEncoding;
  readonly sampleRate: number;
  readonly channels: 1;
}

export function pcm16(sampleRate: number): AudioFormat {
  return { encoding: 'pcm_s16le', sampleRate, channels: 1 };
}

export function mulaw8k(): AudioFormat {
  return { encoding: 'mulaw', sampleRate: 8000, channels: 1 };
}

export function bytesPerSample(format: AudioFormat): number {
  return format.encoding === 'pcm_s16le' ? 2 : 1;
}

export function durationMs(byteLength: number, format: AudioFormat): number {
  return (byteLength / bytesPerSample(format) / format.sampleRate) * 1000;
}

export function bytesForDuration(ms: number, format: AudioFormat): number {
  const samples = Math.round((format.sampleRate * ms) / 1000);
  return samples * bytesPerSample(format);
}

/**
 * View PCM16 little-endian bytes as samples. Copies only when the buffer is not 2-byte aligned
 * (Int16Array requires alignment). Assumes a little-endian host, which covers every Node target.
 */
export function pcm16Samples(bytes: Uint8Array): Int16Array {
  const length = Math.floor(bytes.byteLength / 2);
  if (bytes.byteOffset % 2 === 0) {
    return new Int16Array(bytes.buffer, bytes.byteOffset, length);
  }
  const copy = new Uint8Array(length * 2);
  copy.set(bytes.subarray(0, length * 2));
  return new Int16Array(copy.buffer);
}

export function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const chunk of chunks) total += chunk.byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export function formatsEqual(a: AudioFormat, b: AudioFormat): boolean {
  return a.encoding === b.encoding && a.sampleRate === b.sampleRate && a.channels === b.channels;
}

export function describeFormat(format: AudioFormat): string {
  return `${format.encoding}@${format.sampleRate}`;
}
