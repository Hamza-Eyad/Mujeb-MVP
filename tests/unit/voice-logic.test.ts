import { describe, expect, it } from 'vitest';
import { normalizeArabic, tokenize } from '../../src/voice/arabic-text.js';
import { DEFAULT_BARGE_IN_POLICY, evaluateBargeIn, isEchoOf } from '../../src/voice/barge-in-policy.js';
import { EnergyVad, rmsDb } from '../../src/voice/energy-vad.js';
import { chunkText } from '../../src/voice/text-chunker.js';

async function* fromArray(items: string[]): AsyncGenerator<string> {
  for (const item of items) {
    await Promise.resolve(); // deltas arrive asynchronously, like an LLM stream
    yield item;
  }
}

async function collect(gen: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const item of gen) out.push(item);
  return out;
}

describe('normalizeArabic', () => {
  it('unifies letter variants, strips diacritics/punctuation, maps digits, collapses elongation', () => {
    expect(normalizeArabic('أَهلاً بِكُم في العِيادَة!')).toBe('اهلا بكم في العياده');
    expect(normalizeArabic('إلى مستشفى')).toBe('الي مستشفي');
    expect(normalizeArabic('الساعة ١٠:٣٠')).toBe('الساعه 10 30');
    expect(normalizeArabic('اااااه')).toBe('اه');
    expect(normalizeArabic('آه')).toBe('اه');
    expect(tokenize('  ،،  ')).toEqual([]);
  });
});

describe('evaluateBargeIn', () => {
  const agent = 'عيادتنا تفتح من الساعة ثمانية الصباح إلى الساعة عشرة المساء';
  const evaluate = (text: string, final = false) => evaluateBargeIn(text, { fullText: agent, spokenSoFar: agent }, DEFAULT_BARGE_IN_POLICY, { final });

  it('ignores empty transcripts and pure backchannels', () => {
    expect(evaluate('   ').action).toBe('ignore');
    expect(evaluate('اها')).toMatchObject({ action: 'ignore', reason: 'backchannel' });
    expect(evaluate('ايه ايه', true)).toMatchObject({ action: 'ignore', reason: 'backchannel' });
    expect(evaluate('ممممم')).toMatchObject({ action: 'ignore', reason: 'backchannel' });
  });

  it('ignores an echo of what Mujeeb is saying', () => {
    expect(evaluate('تفتح من الساعة ثمانية')).toMatchObject({ action: 'ignore', reason: 'echo' });
  });

  it('treats a single unknown word as a candidate, but a final one as an interruption', () => {
    expect(evaluate('لا')).toMatchObject({ action: 'candidate', reason: 'short' });
    expect(evaluate('لا', true)).toMatchObject({ action: 'interrupt', reason: 'speech' });
  });

  it('interrupts on real multi-word speech, even if it starts with a backchannel', () => {
    expect(evaluate('لا لحظة')).toMatchObject({ action: 'interrupt', reason: 'speech' });
    expect(evaluate('طيب ابي اسأل عن الدوام')).toMatchObject({ action: 'interrupt' });
  });

  it('detects echo tail after playback', () => {
    expect(isEchoOf('الساعة عشرة المساء', agent, DEFAULT_BARGE_IN_POLICY)).toBe(true);
    expect(isEchoOf('ابي موعد بكرة', agent, DEFAULT_BARGE_IN_POLICY)).toBe(false);
  });
});

describe('chunkText', () => {
  it('emits segments at punctuation followed by whitespace, as deltas arrive', async () => {
    const deltas = ['هلا والله، ', 'كيف أقدر أساعدك اليوم؟ ', 'الدوام من ', 'الساعة 8:30 صباحاً.'];
    const out = await collect(chunkText(fromArray(deltas), { firstMinChars: 8, minChars: 30, maxChars: 200 }));
    expect(out).toEqual(['هلا والله،', 'كيف أقدر أساعدك اليوم؟ الدوام من الساعة 8:30 صباحاً.']);
    // With the default first-segment minimum (12 chars) a very short opener is merged with the next clause.
    const merged = await collect(chunkText(fromArray(deltas)));
    expect(merged[0]).toBe('هلا والله، كيف أقدر أساعدك اليوم؟');
  });

  it('does not split decimals or times split across deltas', async () => {
    const out = await collect(chunkText(fromArray(['السعر 3', '.5 ريال والموعد 10', ':30 مساءً لو سمحت'])));
    expect(out).toEqual(['السعر 3.5 ريال والموعد 10:30 مساءً لو سمحت']);
  });

  it('forces a cut at maxChars on a word boundary', async () => {
    const long = 'كلمة '.repeat(60);
    const out = await collect(chunkText(fromArray([long]), { firstMinChars: 10, minChars: 30, maxChars: 50 }));
    expect(out.length).toBeGreaterThan(1);
    for (const piece of out) expect(piece.length).toBeLessThanOrEqual(50);
    expect(out.join(' ').split(' ').filter(Boolean)).toHaveLength(60);
  });
});

describe('EnergyVad', () => {
  const RATE = 16000;
  const frame = (amplitude: number): Int16Array => {
    const samples = new Int16Array(320); // 20ms
    for (let i = 0; i < samples.length; i += 1) samples[i] = Math.round(amplitude * Math.sin((2 * Math.PI * 220 * i) / RATE));
    return samples;
  };

  it('computes dBFS', () => {
    expect(rmsDb(frame(32767))).toBeCloseTo(-3, 0);
    expect(rmsDb(new Int16Array(320))).toBeLessThan(-100);
  });

  it('detects speech start after minSpeechMs and end after hangover', () => {
    const vad = new EnergyVad(); // minSpeechMs 100 (5 frames), hangoverMs 300 (15 frames)
    const events: string[] = [];
    const feed = (amplitude: number, frames: number, label: string): void => {
      for (let i = 0; i < frames; i += 1) {
        const e = vad.process(frame(amplitude), RATE);
        if (e) events.push(`${label}:${e.type}@${i}:${e.type === 'speech_start' ? e.startedMsAgo : e.endedMsAgo}`);
      }
    };
    feed(0, 10, 'silence');
    feed(8000, 20, 'speech');
    feed(0, 20, 'silence');
    expect(events).toEqual(['speech:speech_start@4:100', 'silence:speech_end@14:300']);
  });

  it('ignores short clicks and low background noise', () => {
    const vad = new EnergyVad();
    const results = [
      ...Array.from({ length: 2 }, () => vad.process(frame(8000), RATE)), // 40ms click
      ...Array.from({ length: 50 }, () => vad.process(frame(60), RATE)), // ≈ -58 dBFS hum
    ];
    expect(results.every((r) => r === null)).toBe(true);
    expect(vad.isSpeaking).toBe(false);
  });
});
