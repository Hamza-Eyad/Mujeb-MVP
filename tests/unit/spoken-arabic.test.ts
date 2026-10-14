import { describe, expect, it } from 'vitest';
import { numberWords, spokenCalendarDate, spokenDate, spokenDateTime, spokenDigits, spokenDoctor, spokenTime } from '../../src/agent/tools/spoken-arabic.js';

/** Deterministic spoken dates and times (plan step 8): what the caller confirms is never worded by the model. */

const RIYADH = 'Asia/Riyadh';
const NOW = new Date('2026-10-13T06:00:00Z'); // Tuesday 09:00 in Riyadh

describe('spoken Saudi-Arabic numbers', () => {
  it.each([
    [1, 'واحد'],
    [6, 'ستّ'],
    [11, 'إحدعش'],
    [12, 'اطنعش'],
    [13, 'ثلطعش'],
    [15, 'خمسطعش'],
    [16, 'سطّعش'],
    [20, 'عشرين'],
    [21, 'واحد وعشرين'],
    [31, 'واحد وثلاثين'],
    [45, 'خمس وأربعين'],
    [150, 'مية وخمسين'],
    [1250, 'ألف وميتين وخمسين'],
    [1991, 'ألف وتسعمية وواحد وتسعين'],
    [2020, 'ألفين وعشرين'],
    [2027, 'ألفين وسبع وعشرين'],
  ])('%i → %s', (n, words) => {
    expect(numberWords(n)).toBe(words);
  });

  it('refuses what it cannot say', () => {
    expect(() => numberWords(-1)).toThrow(RangeError);
    expect(() => numberWords(1.5)).toThrow(RangeError);
    expect(() => numberWords(10_000)).toThrow(RangeError);
  });

  it('reads identifiers digit by digit, keeping every zero', () => {
    expect(spokenDigits('0500000199')).toBe('صفر خمسة صفر صفر صفر صفر صفر واحد تسعة تسعة');
    expect(spokenDigits('١٠٦')).toBe(''); // only ASCII digits reach here (inputs are normalized first)
  });
});

describe('spoken dates', () => {
  it('tells the 13th from the 15th, with the matching weekday', () => {
    expect(spokenDate('2026-10-13', 2026)).toBe('الثلاثاء ثلطعش أكتوبر');
    expect(spokenDate('2026-10-15', 2026)).toBe('الخميس خمسطعش أكتوبر');
    expect(spokenDate('2026-10-13', 2026)).not.toContain('خمسطعش');
  });

  it('computes the weekday from the date itself, across months and years', () => {
    expect(spokenDate('2026-10-31', 2026)).toBe('السبت واحد وثلاثين أكتوبر');
    expect(spokenDate('2026-11-01', 2026)).toBe('الأحد واحد نوفمبر');
    expect(spokenDate('2026-02-28', 2026)).toBe('السبت ثمان وعشرين فبراير');
    expect(spokenDate('2028-02-29', 2028)).toBe('الثلاثاء تسع وعشرين فبراير'); // leap day
  });

  it('adds the year only when it is not the current one (year boundary)', () => {
    expect(spokenDate('2026-12-31', 2026)).toBe('الخميس واحد وثلاثين ديسمبر');
    expect(spokenDate('2027-01-01', 2026)).toBe('الجمعة واحد يناير ألفين وسبع وعشرين');
  });

  it('says a date of birth with its year and without a weekday', () => {
    expect(spokenCalendarDate('1991-02-03')).toBe('ثلاث فبراير ألف وتسعمية وواحد وتسعين');
  });
});

describe('spoken times (12-hour clock, explicit period)', () => {
  it.each([
    ['09:00', 'تسع صباحًا'],
    ['09:15', 'تسع وربع صباحًا'],
    ['10:30', 'عشر ونص صباحًا'],
    ['11:40', 'اطنعش إلّا ثُلث صباحًا'],
    ['12:00', 'اطنعش ظهرًا'],
    ['12:20', 'اطنعش وثُلث ظهرًا'],
    ['13:00', 'وحدة ظهرًا'],
    ['14:40', 'ثلاث إلّا ثُلث ظهرًا'],
    ['16:00', 'أربع مساءً'],
    ['16:40', 'خمس إلّا ثُلث مساءً'],
    ['17:00', 'خمس مساءً'],
    ['18:20', 'ستّ وثُلث مساءً'],
    ['20:45', 'تسع إلّا ربع مساءً'],
    ['23:50', 'اطنعش إلّا عشر مساءً'],
    ['00:00', 'منتصف الليل'],
    ['00:30', 'اطنعش ونص صباحًا'],
    ['08:07', 'ثمان وسبع دقايق صباحًا'],
    ['08:13', 'ثمان وثلطعش دقيقة صباحًا'],
  ])('%s → %s', (time, words) => {
    expect(spokenTime(time)).toBe(words);
  });

  it('never uses period names that listeners place differently', () => {
    for (let h = 0; h < 24; h += 1) {
      for (const m of [0, 20, 30, 40]) {
        const words = spokenTime(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`);
        expect(words).not.toMatch(/العصر|المغرب|العشا|الفجر/);
        expect(words).not.toMatch(/[0-9٠-٩]/);
      }
    }
  });
});

describe('spoken date and time of an instant, in the clinic time zone', () => {
  it('uses Asia/Riyadh: an instant before UTC midnight is already the next day in Riyadh', () => {
    // 2026-10-12 21:30 UTC = Tuesday 2026-10-13 00:30 in Riyadh.
    expect(spokenDateTime(new Date('2026-10-12T21:30:00Z'), RIYADH, NOW)).toBe('يوم الثلاثاء ثلطعش أكتوبر، الساعة اطنعش ونص صباحًا');
    // 2026-10-13 13:00 UTC = Tuesday 16:00 in Riyadh (the slot the model misread as the 15th).
    expect(spokenDateTime(new Date('2026-10-13T13:00:00Z'), RIYADH, NOW)).toBe('يوم الثلاثاء ثلطعش أكتوبر، الساعة أربع مساءً');
    // Midnight and noon.
    expect(spokenDateTime(new Date('2026-10-14T21:00:00Z'), RIYADH, NOW)).toBe('يوم الخميس خمسطعش أكتوبر، الساعة منتصف الليل');
    expect(spokenDateTime(new Date('2026-10-15T09:00:00Z'), RIYADH, NOW)).toBe('يوم الخميس خمسطعش أكتوبر، الساعة اطنعش ظهرًا');
  });

  it('adds the year across a year boundary', () => {
    const lateDecember = new Date('2026-12-30T09:00:00Z');
    expect(spokenDateTime(new Date('2027-01-03T06:00:00Z'), RIYADH, lateDecember)).toBe('يوم الأحد ثلاث يناير ألفين وسبع وعشرين، الساعة تسع صباحًا');
  });

  it('titles doctors by gender', () => {
    expect(spokenDoctor('سارة الغامدي', 'female')).toBe('الدّكتورة سارة الغامدي');
    expect(spokenDoctor('فهد العتيبي', 'male')).toBe('الدّكتور فهد العتيبي');
    expect(spokenDoctor('Dr. Smith', undefined)).toBe('Dr. Smith');
  });
});
