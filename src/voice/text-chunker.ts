/**
 * Turns a stream of LLM text deltas into speakable segments as early as possible.
 * A segment ends at sentence/clause punctuation (Arabic or Latin) that is followed by whitespace,
 * so "10:30" or "3.5" are never split. The first segment may be shorter to cut time-to-first-audio.
 */

export interface ChunkerOptions {
  firstMinChars: number;
  minChars: number;
  maxChars: number;
}

export const DEFAULT_CHUNKER_OPTIONS: ChunkerOptions = { firstMinChars: 12, minChars: 30, maxChars: 200 };

const BOUNDARY = new Set(['.', '!', '?', '؟', '؛', ';', ':', '،', ',', '…']);

/**
 * A delta equal to this marker makes the chunker emit whatever it holds right away — e.g. a short
 * "one moment" before the model waits on a tool, which would otherwise sit in the buffer in silence.
 */
export const CHUNK_FLUSH = '\u0000flush\u0000';

export async function* chunkText(deltas: AsyncIterable<string>, options: ChunkerOptions = DEFAULT_CHUNKER_OPTIONS): AsyncGenerator<string> {
  let buffer = '';
  let emitted = 0;
  for await (const delta of deltas) {
    if (delta === CHUNK_FLUSH) {
      const held = buffer.trim();
      buffer = '';
      if (held !== '') {
        emitted += 1;
        yield held;
      }
      continue;
    }
    buffer += delta;
    for (;;) {
      const cut = findCut(buffer, emitted === 0 ? options.firstMinChars : options.minChars, options.maxChars);
      if (cut === -1) break;
      const piece = buffer.slice(0, cut).trim();
      buffer = buffer.slice(cut);
      if (piece !== '') {
        emitted += 1;
        yield piece;
      }
    }
  }
  const rest = buffer.trim();
  if (rest !== '') yield rest;
}

export function findCut(buffer: string, minChars: number, maxChars: number): number {
  for (let i = 0; i < buffer.length; i += 1) {
    const ch = buffer[i] ?? '';
    const next = buffer[i + 1];
    const isBoundary = ch === '\n' || (BOUNDARY.has(ch) && next !== undefined && /\s/.test(next));
    if (isBoundary && i + 1 >= minChars) return i + 1;
  }
  if (buffer.length > maxChars) {
    const space = buffer.lastIndexOf(' ', maxChars);
    return space > minChars ? space : maxChars;
  }
  return -1;
}
