import { describe, expect, it } from 'vitest';
import { endsWithNumber } from '../../src/voice/number-hold.js';

describe('endsWithNumber', () => {
  it.each([
    'رقم جوالي 0505',
    '0505.',
    '511.',
    'رقم الهوية ١٠٠٠',
    'آآآ، أربعة.',
    'صفر خمسة',
    'خمسة وعشرين',
    'ألف وتسعمية وأربعة وستين',
    'الساعة خمسطعش',
  ])('a dictated number continues: "%s"', (text) => {
    expect(endsWithNumber(text)).toBe(true);
  });

  it.each(['ابي موعد اسنان', 'الأول.', 'تمام', 'رقم الجوال خاطئ', 'خمسة ونص', 'وش العيادات', ''])('not a number at the end: "%s"', (text) => {
    expect(endsWithNumber(text)).toBe(false);
  });
});
