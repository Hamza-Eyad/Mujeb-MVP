/**
 * Phone numbers, independent of any scheduling system. One parser turns what a caller said (or what a
 * system stored) into the canonical form used at the scheduling boundary — E.164, `+9665XXXXXXXX` for
 * Saudi mobiles — and one comparison decides whether two written forms are the same number.
 *
 * - Saudi mobiles are recognized with or without +966 / 00966 / 966, with or without the trunk 0
 *   (also after the country code: "+966 05…"), with any spacing or separators, Arabic-Indic or Persian
 *   digits, invisible direction marks, and spoken digits ("صفر خمسة …", "zero five …").
 * - Other countries only with an explicit international prefix (+ or 00).
 * - Anything else is rejected rather than guessed: wrong lengths, Saudi landlines (not callable back as
 *   mobile), number words that are not single digits ("خمسين"), or other words.
 *
 * Adapters translate the canonical form into what their system can search (`phoneSearchForms`) and compare
 * stored values with `samePhone` — external systems do not store phone numbers consistently.
 */

export type PhoneRejection = 'empty' | 'invalid' | 'not_mobile';
export type PhoneParse = { ok: true; e164: string; saudiMobile: boolean } | { ok: false; reason: PhoneRejection };

const SAUDI_CC = '966';
const E164 = /^\+[1-9]\d{7,14}$/;
/** Bidi and zero-width format characters that text with mixed directions often carries. */
const FORMAT_CHARS = /[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff\u00ad]/g;
/** Separators people and systems put between digits. */
const SEPARATORS = /[\s\-–—.,،؛;:()[\]/\\_]+/g;

/** Single-digit words (Arabic incl. Saudi forms, and English) → digit. Matched after the normalization in `wordKey`. */
const DIGIT_WORDS: ReadonlyMap<string, string> = new Map(
  (
    [
      ['0', ['صفر', 'zero', 'oh']],
      ['1', ['واحد', 'وحده', 'one']],
      ['2', ['اثنين', 'اثنان', 'ثنين', 'ثنتين', 'اثنتين', 'two']],
      ['3', ['ثلاثه', 'ثلاث', 'تلاته', 'three']],
      ['4', ['اربعه', 'اربع', 'four']],
      ['5', ['خمسه', 'خمس', 'five']],
      ['6', ['سته', 'ست', 'six']],
      ['7', ['سبعه', 'سبع', 'seven']],
      ['8', ['ثمانيه', 'ثمان', 'ثماني', 'تمانيه', 'eight']],
      ['9', ['تسعه', 'تسع', 'nine']],
    ] as const
  ).flatMap(([digit, words]) => words.map((w) => [w, digit] as const)),
);
const PLUS_WORDS: ReadonlySet<string> = new Set(['زايد', 'زائد', 'plus']);

/** Parses a phone number as spoken or written. */
export function parsePhone(input: string): PhoneParse {
  const text = toAsciiDigits(input.normalize('NFKC')).replace(FORMAT_CHARS, '').replace(/^tel:/i, '').trim();
  if (text === '') return { ok: false, reason: 'empty' };
  const sequence = toDigitSequence(text);
  if (sequence === undefined || sequence.digits === '') return { ok: false, reason: 'invalid' };
  const { plus, digits } = sequence;

  // An explicit international prefix: "+…" or "00…".
  const international = plus ? digits : digits.startsWith('00') ? digits.slice(2) : undefined;
  if (international !== undefined) {
    if (international.startsWith(SAUDI_CC)) return saudi(international.slice(SAUDI_CC.length));
    return E164.test(`+${international}`) ? { ok: true, e164: `+${international}`, saudiMobile: false } : { ok: false, reason: 'invalid' };
  }
  // No prefix: only Saudi forms — with the country code (966…, also 9660…) or national (05…, 5…).
  if (digits.startsWith(SAUDI_CC) && digits.length >= 12) return saudi(digits.slice(SAUDI_CC.length));
  return saudi(digits);
}

/**
 * The digits the input contains (written or spoken), as received — before any validation. For telling a
 * caller what was heard when the number is not usable (e.g. STT dropped a zero). Undefined if it has no digits.
 */
export function phoneDigitsHeard(input: string): string | undefined {
  const sequence = toDigitSequence(toAsciiDigits(input.normalize('NFKC')).replace(FORMAT_CHARS, '').replace(/^tel:/i, '').trim());
  return sequence === undefined || sequence.digits === '' ? undefined : `${sequence.plus ? '+' : ''}${sequence.digits}`;
}

/** The canonical form, or undefined when the input is not a usable number. */
export function canonicalPhone(input: string): string | undefined {
  const parsed = parsePhone(input);
  return parsed.ok ? parsed.e164 : undefined;
}

/** True when `value` is already in canonical form (what the scheduling port expects). */
export function isCanonicalPhone(value: string): boolean {
  return canonicalPhone(value) === value;
}

/** True when two written forms denote the same number. Unparseable values match nothing. */
export function samePhone(a: string | undefined, b: string | undefined): boolean {
  if (a === undefined || b === undefined) return false;
  const x = canonicalPhone(a);
  return x !== undefined && x === canonicalPhone(b);
}

/**
 * Written forms a system may have stored for a canonical number, for exact-match searches (one bounded
 * OR query instead of scanning). Saudi mobiles: E.164 with and without "+", 00-prefixed, national with and
 * without the trunk 0, and the common grouped spellings. Results must still be checked with `samePhone`.
 */
export function phoneSearchForms(canonical: string): string[] {
  const parsed = parsePhone(canonical);
  if (!parsed.ok) return [];
  if (!parsed.saudiMobile) return [parsed.e164];
  const n = parsed.e164.slice(1 + SAUDI_CC.length); // 5XXXXXXXX
  const [a, b, c] = [n.slice(0, 2), n.slice(2, 5), n.slice(5)];
  return [
    parsed.e164,
    `${SAUDI_CC}${n}`,
    `00${SAUDI_CC}${n}`,
    `0${n}`,
    n,
    `+${SAUDI_CC} ${a} ${b} ${c}`,
    `+${SAUDI_CC}-${a}-${b}-${c}`,
    `0${a} ${b} ${c}`,
    `0${a}-${b}-${c}`,
  ];
}

/** Arabic-Indic and Persian digits → ASCII. */
export function toAsciiDigits(text: string): string {
  return text.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660)).replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
}

/** National part after +966 (with or without the trunk 0): must be a mobile, 5 + 8 digits. */
function saudi(national: string): PhoneParse {
  const rest = national.startsWith('0') ? national.slice(1) : national;
  if (/^5\d{8}$/.test(rest)) return { ok: true, e164: `+${SAUDI_CC}${rest}`, saudiMobile: true };
  // Landlines (01X XXX XXXX), toll-free (800…) and unified numbers (9200…): real numbers, but not a patient's mobile.
  if (/^(1\d{8}|800\d{6,7}|9200\d{5})$/.test(rest)) return { ok: false, reason: 'not_mobile' };
  return { ok: false, reason: 'invalid' };
}

/**
 * Digits and spoken digit words → one digit string. A leading "+" (or "زائد"/"plus") is kept as a flag.
 * Any other word — including number words that are not single digits — makes the input unusable.
 */
function toDigitSequence(text: string): { plus: boolean; digits: string } | undefined {
  let plus = false;
  let digits = '';
  const tokens = text.replace(/\+/g, ' + ').split(SEPARATORS).filter((t) => t !== '');
  for (const [i, token] of tokens.entries()) {
    if (token === '+' || PLUS_WORDS.has(wordKey(token))) {
      if (i !== 0 || plus) return undefined;
      plus = true;
      continue;
    }
    if (/^\d+$/.test(token)) {
      digits += token;
      continue;
    }
    const digit = DIGIT_WORDS.get(wordKey(token)) ?? (token.startsWith('و') ? DIGIT_WORDS.get(wordKey(token.slice(1))) : undefined);
    if (digit === undefined) return undefined;
    digits += digit;
  }
  return { plus, digits };
}

/** Spelling-insensitive key for a digit word: no diacritics or tatweel, unified alef/hamza/taa marbuta, lower case. */
function wordKey(word: string): string {
  return word
    .replace(/[ً-ْٰـ]/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/ئ/g, 'ي')
    .toLowerCase();
}
