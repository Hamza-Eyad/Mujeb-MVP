import { normalizeArabic } from '../core/arabic-text.js';

/**
 * Callers dictate IDs, phone numbers and dates in groups, with pauses ("0505 … 430 … 530"). To the STT's VAD a pause
 * after a group looks like the end of the turn, so a reply would start on half a number and talk over the rest
 * (observed live, 2026-11-09). When the caller's words so far end with a number, the session waits a little longer
 * for the rest before answering (VoiceSessionConfig.numberHoldMs).
 */

/** Spoken number words (normalized: no hamza variants, ة → ه), Saudi and standard forms. */
const NUMBER_WORDS = new Set([
  'صفر',
  'واحد',
  'وحده',
  'اثنين',
  'ثنين',
  'اثنان',
  'ثلاث',
  'ثلاثه',
  'اربع',
  'اربعه',
  'خمس',
  'خمسه',
  'ست',
  'سته',
  'سبع',
  'سبعه',
  'ثمان',
  'ثماني',
  'ثمانيه',
  'ثمنيه',
  'تسع',
  'تسعه',
  'عشر',
  'عشره',
  'احدعش',
  'اطنعش',
  'ثلطعش',
  'اربعطعش',
  'خمسطعش',
  'سطعش',
  'سبعطعش',
  'ثمنطعش',
  'تسعطعش',
  'عشرين',
  'ثلاثين',
  'اربعين',
  'خمسين',
  'ستين',
  'سبعين',
  'ثمانين',
  'تسعين',
  'ميه',
  'ميتين',
  'ثلاثميه',
  'اربعميه',
  'خمسميه',
  'ستميه',
  'سبعميه',
  'ثمانميه',
  'ثمنميه',
  'تسعميه',
  'الف',
  'الفين',
  'الاف',
]);

/** True when the text's last word is a number: digits, or a spoken number word (also with a leading "و"). */
export function endsWithNumber(text: string): boolean {
  const last = normalizeArabic(text).split(' ').filter((t) => t !== '').at(-1);
  if (last === undefined) return false;
  if (/\d/.test(last)) return true;
  if (NUMBER_WORDS.has(last)) return true;
  return last.length > 2 && last.startsWith('و') && NUMBER_WORDS.has(last.slice(1));
}
