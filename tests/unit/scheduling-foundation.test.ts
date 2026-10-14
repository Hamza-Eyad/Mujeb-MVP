import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadSchedulingDataset } from '../../src/app/scheduling-dataset.js';
import { parseSchedulingDataset, practitionerWorksOn, resolveDatasetDates } from '../../src/contracts/scheduling-dataset.js';
import * as coreArabic from '../../src/core/arabic-text.js';
import { ConfigError, SchedulingError, errorSummary } from '../../src/core/errors.js';
import { isE164Phone, isNationalIdFormat, nationalIdChecksumValid } from '../../src/core/identifiers.js';
import { matchScore, rankByText, searchTokens } from '../../src/core/text-match.js';
import { addDays, daysBetween, formatMinutes, instantToZoned, isLocalDate, minutesOfDay, weekdayOf, zonedToInstant } from '../../src/core/zoned-time.js';
import * as voiceArabic from '../../src/voice/arabic-text.js';

const DATASET_FILE = 'config/test-data/demo-clinic.dataset.json';
const rawDataset = (): Record<string, unknown> => JSON.parse(readFileSync(DATASET_FILE, 'utf8')) as Record<string, unknown>;

describe('zoned time', () => {
  it('converts clinic wall time to instants and back (Asia/Riyadh, UTC+3)', () => {
    const instant = zonedToInstant('2026-10-12', '16:30', 'Asia/Riyadh');
    expect(instant.toISOString()).toBe('2026-10-12T13:30:00.000Z');
    expect(instantToZoned(instant, 'Asia/Riyadh')).toEqual({ date: '2026-10-12', time: '16:30', weekday: 1, minutes: 990 });
    expect(instantToZoned(new Date('2026-10-12T22:15:00Z'), 'Asia/Riyadh')).toMatchObject({ date: '2026-10-13', time: '01:15' });
  });

  it('handles daylight-saving zones correctly', () => {
    expect(zonedToInstant('2026-01-15', '09:00', 'America/New_York').toISOString()).toBe('2026-01-15T14:00:00.000Z');
    expect(zonedToInstant('2026-07-01', '09:00', 'America/New_York').toISOString()).toBe('2026-07-01T13:00:00.000Z');
    expect(instantToZoned(new Date('2026-07-01T13:00:00Z'), 'America/New_York').time).toBe('09:00');
  });

  it('does calendar arithmetic across months, years and leap days', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(daysBetween('2026-10-12', '2026-10-19')).toBe(7);
    expect(weekdayOf('2026-10-12')).toBe(1); // Monday
    expect(isLocalDate('2026-02-30')).toBe(false);
    expect(minutesOfDay('16:40')).toBe(1000);
    expect(formatMinutes(1000)).toBe('16:40');
  });
});

describe('directory text matching', () => {
  it('normalizes titles, the article, hamza variants and "عبد الله"', () => {
    expect(searchTokens('د. عبد الله الحربي')).toEqual(searchTokens('عبدالله الحربى'));
    expect(searchTokens('الدكتورة سارة')).toEqual(searchTokens('ساره'));
    expect(searchTokens('طب الأطفال')).toEqual(['اطفال']);
  });

  it('scores exact matches above prefix matches, and unrelated text at zero', () => {
    expect(matchScore('جلدية', ['الأمراض الجلدية'])).toBe(1);
    expect(matchScore('جلد', ['الجلدية'])).toBeCloseTo(0.8);
    expect(matchScore('Dermatology', ['dermatology clinic'])).toBe(1);
    expect(matchScore('قلب', ['الجلدية'])).toBe(0);
    expect(matchScore('', ['الجلدية'])).toBe(0);
  });

  it('ranks best first and drops weak matches', () => {
    const items = [{ name: 'خالد الشهري' }, { name: 'ريم القحطاني' }, { name: 'فهد العتيبي' }];
    const ranked = rankByText('دكتورة ريم', items, (i) => [i.name]);
    expect(ranked.map((r) => r.item.name)).toEqual(['ريم القحطاني']);
  });
});

describe('patient identifiers', () => {
  it('validates canonical formats', () => {
    expect(isNationalIdFormat('1000000100')).toBe(true);
    expect(isNationalIdFormat('3000000100')).toBe(false);
    expect(isNationalIdFormat('١٠٠٠٠٠٠١٠٠')).toBe(false); // Arabic-Indic digits must be normalized before the boundary
    expect(isE164Phone('+966500000101')).toBe(true);
    expect(isE164Phone('0500000101')).toBe(false);
  });

  it('computes the national ID checksum', () => {
    expect(nationalIdChecksumValid('1000000107')).toBe(true);
    expect(nationalIdChecksumValid('1000000100')).toBe(false);
  });
});

describe('scheduling dataset', () => {
  it('loads the demo dataset: synthetic, minimal, and with checksum-failing IDs only', async () => {
    const ds = await loadSchedulingDataset(DATASET_FILE);
    expect(ds.synthetic).toBe(true);
    expect([ds.services.length, ds.practitioners.length, ds.patients.length, ds.appointments.length, ds.blocks.length]).toEqual([3, 4, 5, 4, 1]);
    for (const p of ds.patients) expect(nationalIdChecksumValid(p.nationalId)).toBe(false);
  });

  it('rejects a dataset with a real-looking national ID, a non-synthetic flag, or broken references', () => {
    const withValidId = rawDataset();
    (withValidId['patients'] as Record<string, unknown>[])[0]!['nationalId'] = '1000000107';
    expect(() => parseSchedulingDataset(withValidId)).toThrow(/checksum/);

    const notSynthetic = { ...rawDataset(), synthetic: false };
    expect(() => parseSchedulingDataset(notSynthetic)).toThrow(ConfigError);

    const brokenRef = rawDataset();
    (brokenRef['appointments'] as Record<string, unknown>[])[0]!['practitionerKey'] = 'dr-nobody';
    expect(() => parseSchedulingDataset(brokenRef)).toThrow(/unknown practitioner 'dr-nobody'/);

    const wrongService = rawDataset();
    (wrongService['appointments'] as Record<string, unknown>[])[0]!['serviceKey'] = 'dermatology';
    expect(() => parseSchedulingDataset(wrongService)).toThrow(/does not offer/);
  });

  it('places every appointment on a working, unblocked day for any anchor weekday', () => {
    const ds = parseSchedulingDataset(rawDataset());
    for (let offset = 0; offset < 7; offset += 1) {
      const anchor = addDays('2026-10-11', offset);
      const { appointments, blocks } = resolveDatasetDates(ds, anchor);
      expect(appointments).toHaveLength(ds.appointments.length);
      for (const a of appointments) {
        const practitioner = ds.practitioners.find((p) => p.key === a.practitionerKey);
        if (!practitioner) throw new Error('unknown practitioner');
        expect(daysBetween(anchor, a.date)).toBeGreaterThan(0);
        expect(practitionerWorksOn(practitioner, a.date)).toBe(true);
        expect(blocks.some((b) => b.practitionerKey === a.practitionerKey && b.startDate <= a.date && a.date <= b.endDate)).toBe(false);
      }
    }
  });

  it('fails clearly when the dataset file is missing', async () => {
    await expect(loadSchedulingDataset('config/test-data/missing.dataset.json')).rejects.toBeInstanceOf(ConfigError);
  });
});

describe('shared building blocks', () => {
  it('keeps the voice import path for Arabic normalization after the move to core', () => {
    expect(voiceArabic.normalizeArabic).toBe(coreArabic.normalizeArabic);
    expect(voiceArabic.tokenize).toBe(coreArabic.tokenize);
  });

  it('summarizes SchedulingError like other normalized errors', () => {
    expect(errorSummary(new SchedulingError('memory', 'slot_unavailable', 'taken'))).toEqual({
      error_name: 'SchedulingError',
      error_kind: 'slot_unavailable',
      provider: 'memory',
      message: 'taken',
    });
  });
});
