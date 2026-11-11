import { normalizeArabic, tokenize } from './arabic-text.js';

/**
 * Decides what a user transcript heard *while Mujeeb is talking* means:
 * - ignore:    empty, only backchannel words ("اها", "ايه"), or an echo of Mujeeb's own speech;
 * - candidate: too short to be sure — pause playback and wait for more transcript;
 * - interrupt: real speech — stop everything and hand the turn to the user.
 * Pure and deterministic so it can be tuned against the manual echo test matrix.
 */

export type BargeInAction = 'ignore' | 'candidate' | 'interrupt';
export type BargeInReason = 'empty' | 'backchannel' | 'echo' | 'short' | 'speech';

export interface BargeInDecision {
  action: BargeInAction;
  reason: BargeInReason;
  words: number;
  echoOverlap?: number;
}

export interface BargeInPolicy {
  /** Partial transcripts with at least this many (non-echo, non-backchannel) words interrupt immediately. */
  minInterruptWords: number;
  /** Fraction of transcript words found in Mujeeb's current text above which it is treated as echo. */
  echoOverlapRatio: number;
  /** Echo matching of partials needs at least this many words. */
  echoMinWords: number;
  /**
   * A transcript whose every word is at least this similar (0–1, letters) to the word in the same place of a run of
   * Mujeeb's own consecutive words is echo too, though STT misheard some letters (observed live on speakerphone:
   * the greeting's "هلا والله" came back as "خلوا والله"). 0 = off.
   */
  echoFuzzySimilarity: number;
  /**
   * A single *committed* word is treated as echo only if it is among Mujeeb's last N words.
   * Keeps a genuine "لا" from being swallowed because "لا" appeared earlier in a long reply.
   */
  echoRecentWords: number;
  /** Normalized backchannel tokens (see normalizeArabic). */
  backchannels: ReadonlySet<string>;
}

const DEFAULT_BACKCHANNELS = [
  'اه', 'اها', 'ايه', 'ايوه', 'ايوا', 'اي', 'اوه', 'اوكي', 'ok', 'okay',
  'تمام', 'طيب', 'م', 'ام', 'هم', 'يب', 'صح',
];

export const DEFAULT_BARGE_IN_POLICY: BargeInPolicy = {
  minInterruptWords: 2,
  echoOverlapRatio: 0.6,
  echoMinWords: 2,
  echoFuzzySimilarity: 0.6,
  echoRecentWords: 8,
  backchannels: new Set(DEFAULT_BACKCHANNELS.map(normalizeArabic)),
};

/**
 * `agent.fullText`   — everything Mujeeb has sent to TTS this turn (superset of anything that could echo).
 * `agent.spokenSoFar`— text up to the latest generated audio (closest to the playback position).
 */
export interface AgentSpeech {
  fullText: string;
  spokenSoFar: string;
}

export function evaluateBargeIn(
  transcript: string,
  agent: AgentSpeech,
  policy: BargeInPolicy,
  options: { final: boolean },
): BargeInDecision {
  const words = tokenize(transcript);
  if (words.length === 0) return { action: 'ignore', reason: 'empty', words: 0 };
  if (words.every((w) => policy.backchannels.has(w))) {
    return { action: 'ignore', reason: 'backchannel', words: words.length };
  }
  const echoOverlap = overlapRatio(words, agent.fullText);
  if (words.length >= policy.echoMinWords && (echoOverlap >= policy.echoOverlapRatio || isNearCopy(words, agent.fullText, policy))) {
    return { action: 'ignore', reason: 'echo', words: words.length, echoOverlap };
  }
  const [onlyWord] = words;
  if (options.final && words.length === 1 && onlyWord !== undefined && policy.echoRecentWords > 0) {
    const recent = tokenize(agent.spokenSoFar).slice(-policy.echoRecentWords);
    if (recent.includes(onlyWord)) return { action: 'ignore', reason: 'echo', words: 1, echoOverlap };
  }
  if (options.final || words.length >= policy.minInterruptWords) {
    return { action: 'interrupt', reason: 'speech', words: words.length, echoOverlap };
  }
  return { action: 'candidate', reason: 'short', words: words.length, echoOverlap };
}

/** Used right after Mujeeb stops talking: a committed transcript matching its last reply is echo tail. */
export function isEchoOf(transcript: string, agentText: string, policy: BargeInPolicy): boolean {
  const words = tokenize(transcript);
  return words.length >= policy.echoMinWords && (overlapRatio(words, agentText) >= policy.echoOverlapRatio || isNearCopy(words, agentText, policy));
}

/**
 * Is the transcript a misheard copy of consecutive words Mujeeb said? Word by word, in order: every word must
 * resemble the word in the same place of some run of Mujeeb's words, after folding the sounds STT tends to swap in
 * Saudi speech over a phone line. One word of the caller's own (they rarely resemble Mujeeb's) breaks the match,
 * so an echoed phrase followed by "لا لحظة" still interrupts.
 */
function isNearCopy(words: readonly string[], agentText: string, policy: BargeInPolicy): boolean {
  if (policy.echoFuzzySimilarity <= 0 || words.length < policy.echoMinWords) return false;
  const said = tokenize(agentText).map(foldSounds);
  const heard = words.map(foldSounds);
  for (let start = 0; start + heard.length <= said.length; start += 1) {
    if (heard.every((word, i) => similarity(word, said[start + i] ?? '') >= policy.echoFuzzySimilarity)) return true;
  }
  return false;
}

/** Letters STT confuses on Saudi phone speech, as one letter each (normalized text in, for matching only). */
const SOUND_CLASSES: Record<string, string> = { ح: 'ه', خ: 'ه', ع: 'ا', ص: 'س', ث: 'س', ط: 'ت', ظ: 'ض', ذ: 'ز' };

function foldSounds(text: string): string {
  return [...text].map((ch) => SOUND_CLASSES[ch] ?? ch).join('');
}

/** 1 − edit distance / longer length. */
function similarity(a: string, b: string): number {
  const longer = Math.max(a.length, b.length);
  return longer === 0 ? 1 : 1 - editDistance(a, b) / longer;
}

function editDistance(a: string, b: string): number {
  const x = [...a];
  const y = [...b];
  let previous = Array.from({ length: y.length + 1 }, (_v, j) => j);
  for (let i = 1; i <= x.length; i += 1) {
    const row = [i];
    for (let j = 1; j <= y.length; j += 1) {
      const cost = x[i - 1] === y[j - 1] ? 0 : 1;
      row.push(Math.min((previous[j] ?? 0) + 1, (row[j - 1] ?? 0) + 1, (previous[j - 1] ?? 0) + cost));
    }
    previous = row;
  }
  return previous[y.length] ?? 0;
}

function overlapRatio(words: readonly string[], agentText: string): number {
  if (words.length === 0 || agentText.trim() === '') return 0;
  const agentWords = new Set(tokenize(agentText));
  const hits = words.filter((w) => agentWords.has(w)).length;
  return hits / words.length;
}
