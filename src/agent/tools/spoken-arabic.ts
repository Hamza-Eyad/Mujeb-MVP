import { type LocalDate, type LocalTime, instantToZoned, isLocalDate, isLocalTime, minutesOfDay, weekdayOf } from '../../core/zoned-time.js';

/**
 * Deterministic Saudi-Arabic spoken forms for appointment details. Every date and time a caller is asked
 * to confirm is worded here, from the authoritative record — never by the language model (plan step 8:
 * the model once read back "15 October" for a slot on the 13th).
 *
 * - Dates: weekday, day of month and month always come from the same clinic-local date (the year only
 *   when it is not the current one): "الثلاثاء ثلطعش أكتوبر".
 * - Times: 12-hour clock with an explicit period — صباحًا (00:01–11:59), ظهرًا (12:00–14:59),
 *   مساءً (15:00–23:59), and "منتصف الليل" for 00:00. Never العصر/المغرب, which listeners place differently.
 * - Numbers are words (Saudi forms, e.g. ثلطعش, سطّعش); shadda is kept where it guides pronunciation (ستّ).
 */

export const WEEKDAY_NAMES = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'] as const;
export const MONTH_NAMES = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'] as const;

const UNITS = [
  'صفر',
  'واحد',
  'ثنين',
  'ثلاث',
  'أربع',
  'خمس',
  'ستّ',
  'سبع',
  'ثمان',
  'تسع',
  'عشر',
  'إحدعش',
  'اطنعش',
  'ثلطعش',
  'أربعطعش',
  'خمسطعش',
  'سطّعش',
  'سبعطعش',
  'ثمنطعش',
  'تسعطعش',
] as const;
const TENS = ['', '', 'عشرين', 'ثلاثين', 'أربعين', 'خمسين', 'ستّين', 'سبعين', 'ثمانين', 'تسعين'] as const;
const HUNDREDS = ['', 'مية', 'ميتين', 'ثلاثمية', 'أربعمية', 'خمسمية', 'ستّمية', 'سبعمية', 'ثمانمية', 'تسعمية'] as const;
/** Clock hours 12, 1, 2, … 11. */
const CLOCK_HOURS = ['اطنعش', 'وحدة', 'ثنتين', 'ثلاث', 'أربع', 'خمس', 'ستّ', 'سبع', 'ثمان', 'تسع', 'عشر', 'إحدعش'] as const;
/** Digits read one by one (IDs, phone numbers). */
const DIGITS = ['صفر', 'واحد', 'ثنين', 'ثلاثة', 'أربعة', 'خمسة', 'ستّة', 'سبعة', 'ثمانية', 'تسعة'] as const;

/** 0 … 9999 in Saudi words: "ثلطعش", "واحد وعشرين", "ألف وتسعمية وواحد وتسعين", "ألفين وستّ وعشرين". */
export function numberWords(n: number): string {
  if (!Number.isInteger(n) || n < 0 || n > 9999) throw new RangeError(`numberWords supports 0..9999, got ${n}`);
  if (n < 20) return UNITS[n] ?? '';
  if (n < 100) {
    const unit = n % 10;
    const tens = TENS[Math.floor(n / 10)] ?? '';
    return unit === 0 ? tens : `${UNITS[unit] ?? ''} و${tens}`;
  }
  if (n < 1000) {
    const rest = n % 100;
    const hundreds = HUNDREDS[Math.floor(n / 100)] ?? '';
    return rest === 0 ? hundreds : `${hundreds} و${numberWords(rest)}`;
  }
  const thousands = Math.floor(n / 1000);
  const rest = n % 1000;
  const head = thousands === 1 ? 'ألف' : thousands === 2 ? 'ألفين' : `${UNITS[thousands] ?? ''} آلاف`;
  return rest === 0 ? head : `${head} و${numberWords(rest)}`;
}

/** "الثلاثاء ثلطعش أكتوبر"; the year is added when `date` is not in `currentYear`. */
export function spokenDate(date: LocalDate, currentYear?: number): string {
  const [year, month, day] = parseDate(date);
  const base = `${WEEKDAY_NAMES[weekdayOf(date)]} ${numberWords(day)} ${MONTH_NAMES[month - 1]}`;
  return currentYear !== undefined && year !== currentYear ? `${base} ${numberWords(year)}` : base;
}

/** A date without weekday, with the year (e.g. a date of birth): "ثلاث فبراير ألف وتسعمية وواحد وتسعين". */
export function spokenCalendarDate(date: LocalDate): string {
  const [year, month, day] = parseDate(date);
  return `${numberWords(day)} ${MONTH_NAMES[month - 1]} ${numberWords(year)}`;
}

/** "أربع مساءً", "أربع ونص مساءً", "ثلاث إلّا ثُلث ظهرًا", "اطنعش ظهرًا", "منتصف الليل". */
export function spokenTime(time: LocalTime): string {
  if (!isLocalTime(time)) throw new RangeError(`not a HH:mm time: ${time}`);
  const total = minutesOfDay(time);
  if (total === 0) return 'منتصف الليل';
  const hour = Math.floor(total / 60);
  const minute = total % 60;
  const period = hour < 12 ? 'صباحًا' : hour < 15 ? 'ظهرًا' : 'مساءً';
  const clock = (h: number): string => CLOCK_HOURS[h % 12] ?? '';
  // Diacritics chosen by TTS→STT round trips (plan step 8): plain "ثلث" came back as "ثلاث" (three); "ثُلث" and "إلّا" do not.
  const BEFORE: Record<number, string> = { 40: 'إلّا ثُلث', 45: 'إلّا ربع', 50: 'إلّا عشر', 55: 'إلّا خمس' };
  const AFTER: Record<number, string> = { 0: '', 5: 'وخمس', 10: 'وعشر', 15: 'وربع', 20: 'وثُلث', 25: 'ونص إلّا خمس', 30: 'ونص', 35: 'ونص وخمس' };
  const before = BEFORE[minute];
  if (before !== undefined) return `${clock(hour + 1)} ${before} ${period}`;
  const after = AFTER[minute];
  const minutes = after ?? (minute === 1 ? 'ودقيقة' : minute === 2 ? 'ودقيقتين' : `و${numberWords(minute)} ${minute <= 10 ? 'دقايق' : 'دقيقة'}`);
  return [clock(hour), minutes, period].filter((p) => p !== '').join(' ');
}

/** "يوم الثلاثاء ثلطعش أكتوبر، الساعة أربع مساءً" for an instant, in the clinic's time zone. */
export function spokenDateTime(instant: Date, timeZone: string, now: Date): string {
  const local = instantToZoned(instant, timeZone);
  const currentYear = Number(instantToZoned(now, timeZone).date.slice(0, 4));
  return `يوم ${spokenDate(local.date, currentYear)}، الساعة ${spokenTime(local.time)}`;
}

/** Digits one by one: "0500000199" → "صفر خمسة صفر صفر …". Non-digits are dropped. */
export function spokenDigits(text: string): string {
  return [...text].filter((c) => /[0-9]/.test(c)).map((d) => DIGITS[Number(d)] ?? '').join(' ');
}

/** "الدّكتورة سارة الغامدي" when the gender is known, otherwise the name alone. */
export function spokenDoctor(name: string, gender: 'female' | 'male' | 'unknown' | undefined): string {
  if (gender === 'female') return `الدّكتورة ${name}`;
  if (gender === 'male') return `الدّكتور ${name}`;
  return name;
}

function parseDate(date: LocalDate): [number, number, number] {
  if (!isLocalDate(date)) throw new RangeError(`not a YYYY-MM-DD date: ${date}`);
  const [y, m, d] = date.split('-').map(Number);
  return [y ?? 0, m ?? 0, d ?? 0];
}
