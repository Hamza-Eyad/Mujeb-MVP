import { normalizeArabic } from './arabic-text.js';

/**
 * Small, deterministic text matching for directory search (services, practitioners) in Arabic and
 * English. Tolerates the variants callers and STT produce: hamza/alef/taa-marbuta forms, the
 * definite article, "عبد الله" vs "عبدالله", and titles such as "د." / "دكتورة".
 */

/** Words that carry no identity in a directory query (already in normalized form). */
const STOPWORDS = new Set([
  'د',
  'دكتور',
  'دكتوره',
  'طبيب',
  'طبيبه',
  'طب',
  'عياده',
  'قسم',
  'تخصص',
  'عند',
  'مع',
  'في',
  'dr',
  'doctor',
  'clinic',
]);

const PREFIX_WEIGHT = 0.8;
const MIN_PREFIX_CHARS = 3;
/**
 * One letter off (STT slips such as "الأفنان" for "الأسنان", observed live 2026-11-09): a weaker match, only for
 * words long enough that one letter does not turn them into a different common word.
 */
export const FUZZY_WEIGHT = 0.6;
const MIN_FUZZY_CHARS = 4;

/** Normalized identity tokens of `text`. */
export function searchTokens(text: string): string[] {
  const raw = normalizeArabic(text).split(' ').filter((t) => t !== '');
  const joined: string[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const token = raw[i] ?? '';
    const next = raw[i + 1];
    // "عبد الله" / "عبد الرحمن" → one token, so it matches the joined spelling.
    if (token === 'عبد' && next !== undefined) {
      joined.push(token + next);
      i += 1;
    } else {
      joined.push(token);
    }
  }
  return joined.map(stripArticle).filter((t) => t !== '' && !STOPWORDS.has(t));
}

/**
 * How well `query` matches the best of `candidates`, from 0 (nothing) to 1 (every query token found).
 * Exact token matches count fully; prefix matches (≥ 3 chars, either direction) count 0.8.
 */
export function matchScore(query: string, candidates: readonly string[]): number {
  const q = searchTokens(query);
  if (q.length === 0) return 0;
  let best = 0;
  for (const candidate of candidates) {
    const c = searchTokens(candidate);
    if (c.length === 0) continue;
    let total = 0;
    for (const token of q) total += tokenWeight(token, c);
    best = Math.max(best, total / q.length);
  }
  return Math.round(best * 1000) / 1000;
}

export interface Ranked<T> {
  item: T;
  score: number;
}

/** Items whose best text matches `query` with at least `minScore`, best first (stable for ties). */
export function rankByText<T>(
  query: string,
  items: readonly T[],
  textsOf: (item: T) => readonly string[],
  options?: { minScore?: number },
): Ranked<T>[] {
  const minScore = options?.minScore ?? 0.5;
  return items
    .map((item, index) => ({ item, score: matchScore(query, textsOf(item)), index }))
    .filter((r) => r.score >= minScore)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(({ item, score }) => ({ item, score }));
}

function tokenWeight(token: string, candidateTokens: readonly string[]): number {
  let weight = 0;
  for (const c of candidateTokens) {
    if (c === token) return 1;
    const shorter = c.length < token.length ? c : token;
    const longer = shorter === c ? token : c;
    if (shorter.length >= MIN_PREFIX_CHARS && longer.startsWith(shorter)) weight = Math.max(weight, PREFIX_WEIGHT);
    else if (shorter.length >= MIN_FUZZY_CHARS && longer.length - shorter.length <= 1 && withinOneEdit(token, c)) weight = Math.max(weight, FUZZY_WEIGHT);
  }
  return weight;
}

/** True when `a` becomes `b` with at most one letter replaced, inserted or removed. */
function withinOneEdit(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  const [s, l] = a.length <= b.length ? [a, b] : [b, a];
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < s.length && j < l.length) {
    if (s[i] === l[j]) {
      i += 1;
      j += 1;
      continue;
    }
    edits += 1;
    if (edits > 1) return false;
    if (s.length === l.length) i += 1; // replace
    j += 1; // replace or insert into the shorter
  }
  return edits + (l.length - j) + (s.length - i) <= 1;
}

function stripArticle(token: string): string {
  return token.length > 3 && token.startsWith('ال') ? token.slice(2) : token;
}
