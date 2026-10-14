/**
 * Wall-clock dates/times in a named time zone (e.g. a clinic's `Asia/Riyadh`), using only `Intl`.
 * Local dates are `YYYY-MM-DD`, local times `HH:mm` (24h). Instants are plain `Date`s.
 */

export type LocalDate = string;
export type LocalTime = string;

/** 0 = Sunday … 6 = Saturday (same convention as `Date.getUTCDay`). */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

const LOCAL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const LOCAL_TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DAY_MS = 86_400_000;

export function isLocalDate(value: string): boolean {
  const m = LOCAL_DATE.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

export function isLocalTime(value: string): boolean {
  return LOCAL_TIME.test(value);
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** Minutes since local midnight. */
export function minutesOfDay(time: LocalTime): number {
  const m = LOCAL_TIME.exec(time);
  if (!m) throw new RangeError(`Invalid local time: ${time}`);
  return Number(m[1]) * 60 + Number(m[2]);
}

export function formatMinutes(minutes: number): LocalTime {
  if (!Number.isInteger(minutes) || minutes < 0 || minutes >= 24 * 60) throw new RangeError(`Invalid minutes of day: ${minutes}`);
  return `${pad2(Math.floor(minutes / 60))}:${pad2(minutes % 60)}`;
}

export function addDays(date: LocalDate, days: number): LocalDate {
  return fromUtcDays(toUtcDays(date) + days);
}

/** Whole calendar days from `from` to `to` (negative when `to` is earlier). */
export function daysBetween(from: LocalDate, to: LocalDate): number {
  return toUtcDays(to) - toUtcDays(from);
}

export function weekdayOf(date: LocalDate): Weekday {
  return new Date(toUtcDays(date) * DAY_MS).getUTCDay() as Weekday;
}

/** The instant at which the wall clock in `timeZone` shows `date` `time`. */
export function zonedToInstant(date: LocalDate, time: LocalTime, timeZone: string): Date {
  const wall = toUtcDays(date) * DAY_MS + minutesOfDay(time) * 60_000;
  const firstGuess = wall - offsetMs(wall, timeZone);
  const offsetAtGuess = offsetMs(firstGuess, timeZone);
  // A second pass corrects guesses that land on the other side of a DST transition.
  return new Date(wall - offsetAtGuess);
}

export interface ZonedParts {
  date: LocalDate;
  time: LocalTime;
  weekday: Weekday;
  /** Minutes since local midnight. */
  minutes: number;
}

export function instantToZoned(instant: Date, timeZone: string): ZonedParts {
  const ms = instant.getTime();
  if (Number.isNaN(ms)) throw new RangeError('Invalid instant');
  const local = ms + offsetMs(ms, timeZone);
  const date = fromUtcDays(Math.floor(local / DAY_MS));
  const minutes = Math.floor((local - Math.floor(local / DAY_MS) * DAY_MS) / 60_000);
  return { date, time: formatMinutes(minutes), weekday: weekdayOf(date), minutes };
}

// ───────────────────────────── internals ─────────────────────────────

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** UTC offset of `timeZone` at `instantMs` (local wall clock − UTC), in ms. */
function offsetMs(instantMs: number, timeZone: string): number {
  const parts = formatter(timeZone).formatToParts(new Date(instantMs));
  const get = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find((p) => p.type === type)?.value);
  const hour = get('hour') % 24;
  const wall = Date.UTC(get('year'), get('month') - 1, get('day'), hour, get('minute'), get('second'));
  return wall - Math.floor(instantMs / 1000) * 1000;
}

function toUtcDays(date: LocalDate): number {
  const m = LOCAL_DATE.exec(date);
  if (!m || !isLocalDate(date)) throw new RangeError(`Invalid local date: ${date}`);
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / DAY_MS;
}

function fromUtcDays(days: number): LocalDate {
  const d = new Date(days * DAY_MS);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}
