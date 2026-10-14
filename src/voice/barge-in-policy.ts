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
  if (words.length >= policy.echoMinWords && echoOverlap >= policy.echoOverlapRatio) {
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
  return words.length >= policy.echoMinWords && overlapRatio(words, agentText) >= policy.echoOverlapRatio;
}

function overlapRatio(words: readonly string[], agentText: string): number {
  if (words.length === 0 || agentText.trim() === '') return 0;
  const agentWords = new Set(tokenize(agentText));
  const hits = words.filter((w) => agentWords.has(w)).length;
  return hits / words.length;
}
