import { isNationalIdFormat } from '../../core/identifiers.js';
import { canonicalPhone, toAsciiDigits } from '../../core/phone.js';
import { type LocalDate, isLocalDate } from '../../core/zoned-time.js';

/**
 * Turns identifiers as the model passes them (digits as the caller spoke them, possibly Arabic-Indic,
 * with spaces/dashes, local phone formats) into the canonical forms the scheduling port expects.
 * Returns undefined when the value cannot be a valid identifier — callers ask the caller to repeat.
 */

export { toAsciiDigits };

function digitsOnly(text: string): string | undefined {
  const compact = toAsciiDigits(text).replace(/[\s\-.()/]/g, '');
  return /^\+?\d+$/.test(compact) ? compact : undefined;
}

/** Saudi national ID / Iqama: 10 digits starting with 1 or 2. */
export function normalizeNationalId(input: string): string | undefined {
  const digits = digitsOnly(input);
  return digits !== undefined && isNationalIdFormat(digits) ? digits : undefined;
}

/**
 * Phone to the canonical form (E.164; Saudi mobiles +9665XXXXXXXX) with the provider-independent parser
 * in core/phone: any Saudi prefix (+966, 00966, 966, 0, none — also "+966 05…"), separators, Arabic
 * digits, direction marks and spoken digits. Other countries need an explicit + or 00; landlines and
 * anything ambiguous are rejected.
 */
export function normalizePhone(input: string): string | undefined {
  return canonicalPhone(input);
}

/** A real past date (YYYY-MM-DD) no earlier than 1900. `today` is the clinic-local date. */
export function normalizeBirthDate(input: string, today: LocalDate): LocalDate | undefined {
  const value = toAsciiDigits(input).trim();
  if (!isLocalDate(value)) return undefined;
  return value >= '1900-01-01' && value <= today ? value : undefined;
}
