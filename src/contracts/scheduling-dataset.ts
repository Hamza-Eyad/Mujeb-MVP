import { z } from 'zod';
import { ConfigError } from '../core/errors.js';
import { isNationalIdFormat, nationalIdChecksumValid } from '../core/identifiers.js';
import { isCanonicalPhone } from '../core/phone.js';
import {
  type LocalDate,
  type LocalTime,
  type Weekday,
  addDays,
  isLocalDate,
  isLocalTime,
  isValidTimeZone,
  minutesOfDay,
  weekdayOf,
} from '../core/zoned-time.js';

/**
 * Provider-neutral synthetic scheduling dataset (config/test-data/). One file feeds both the
 * in-memory scheduling adapter and any sandbox seed script, so every adapter is tested on the same data.
 * Entities are referenced by descriptive keys, never by a scheduling system's IDs. Dates are
 * relative to an anchor day (normally "today" in the clinic's time zone) so the data never goes stale.
 */

export const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
export type DayName = (typeof DAY_NAMES)[number];

const key = z.string().regex(/^[a-z0-9][a-z0-9-]*$/, { error: 'keys are lowercase kebab-case' });
const text = z.string().trim().min(1);
const localTime = z.string().refine(isLocalTime, { error: 'expected HH:mm (24h)' });
const localDate = z.string().refine(isLocalDate, { error: 'expected YYYY-MM-DD' });

const availabilitySchema = z
  .object({ days: z.array(z.enum(DAY_NAMES)).min(1), start: localTime, end: localTime })
  .refine((a) => minutesOfDay(a.start) < minutesOfDay(a.end), { error: 'start must be before end' });

export const schedulingDatasetSchema = z
  .object({
    version: z.literal(1),
    /** Must be true: this file may only ever contain invented people. */
    synthetic: z.literal(true),
    clinic: z.object({
      key,
      name: text,
      locationName: text,
      timezone: z.string().refine(isValidTimeZone, { error: 'unknown IANA time zone' }),
    }),
    services: z.array(z.object({ key, name: text, aliases: z.array(text).default([]), durationMinutes: z.number().int().min(5).max(240) })).min(1),
    practitioners: z
      .array(
        z.object({
          key,
          name: text,
          gender: z.enum(['female', 'male']),
          aliases: z.array(text).default([]),
          serviceKeys: z.array(key).min(1),
          availability: z.array(availabilitySchema).min(1),
        }),
      )
      .min(1),
    /** Whole days off (e.g. leave), relative to the anchor day: 0 = anchor day. Inclusive. */
    blocks: z
      .array(z.object({ key, practitionerKey: key, fromDayOffset: z.number().int().min(0), toDayOffset: z.number().int().min(0), reason: text }))
      .default([]),
    patients: z
      .array(
        z.object({
          key,
          fullName: text,
          firstName: text.optional(),
          nationalId: z
            .string()
            .refine(isNationalIdFormat, { error: 'expected 10 digits starting with 1 or 2' })
            .refine((id) => !nationalIdChecksumValid(id), { error: 'synthetic national IDs must fail the checksum so they cannot belong to a real person' }),
          phone: z.string().refine(isCanonicalPhone, { error: 'expected a canonical phone (E.164), e.g. +966500000101' }),
          birthDate: localDate,
          gender: z.enum(['female', 'male']),
        }),
      )
      .min(1),
    /**
     * Pre-existing future appointments. `workday` = the Nth day after the anchor on which the
     * practitioner works and is not blocked (1 = first such day), so they always land on a working day.
     */
    appointments: z
      .array(z.object({ key, patientKey: key, practitionerKey: key, serviceKey: key, workday: z.number().int().min(1).max(30), time: localTime }))
      .default([]),
  })
  .superRefine((d, ctx) => {
    const issue = (path: (string | number)[], message: string): void => ctx.addIssue({ code: 'custom', path, message });
    const unique = (name: string, keys: string[]): void => {
      const seen = new Set<string>();
      keys.forEach((k, i) => {
        if (seen.has(k)) issue([name, i, 'key'], `duplicate key '${k}'`);
        seen.add(k);
      });
    };
    unique('services', d.services.map((s) => s.key));
    unique('practitioners', d.practitioners.map((p) => p.key));
    unique('blocks', d.blocks.map((b) => b.key));
    unique('patients', d.patients.map((p) => p.key));
    unique('appointments', d.appointments.map((a) => a.key));
    unique('patients.nationalId', d.patients.map((p) => p.nationalId));

    const services = new Set(d.services.map((s) => s.key));
    const practitioners = new Map(d.practitioners.map((p) => [p.key, p]));
    const patients = new Set(d.patients.map((p) => p.key));
    d.practitioners.forEach((p, i) => {
      p.serviceKeys.forEach((s, j) => {
        if (!services.has(s)) issue(['practitioners', i, 'serviceKeys', j], `unknown service '${s}'`);
      });
    });
    d.blocks.forEach((b, i) => {
      if (!practitioners.has(b.practitionerKey)) issue(['blocks', i, 'practitionerKey'], `unknown practitioner '${b.practitionerKey}'`);
      if (b.toDayOffset < b.fromDayOffset) issue(['blocks', i, 'toDayOffset'], 'toDayOffset must not be before fromDayOffset');
    });
    d.appointments.forEach((a, i) => {
      if (!patients.has(a.patientKey)) issue(['appointments', i, 'patientKey'], `unknown patient '${a.patientKey}'`);
      if (!services.has(a.serviceKey)) issue(['appointments', i, 'serviceKey'], `unknown service '${a.serviceKey}'`);
      const practitioner = practitioners.get(a.practitionerKey);
      if (!practitioner) issue(['appointments', i, 'practitionerKey'], `unknown practitioner '${a.practitionerKey}'`);
      else if (!practitioner.serviceKeys.includes(a.serviceKey)) issue(['appointments', i, 'serviceKey'], `practitioner '${a.practitionerKey}' does not offer '${a.serviceKey}'`);
    });
  });

export type SchedulingDataset = z.infer<typeof schedulingDatasetSchema>;
export type DatasetPractitioner = SchedulingDataset['practitioners'][number];

export function parseSchedulingDataset(raw: unknown): SchedulingDataset {
  const parsed = schedulingDatasetSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ConfigError(`Invalid scheduling dataset: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  return parsed.data;
}

export function dayNameToWeekday(day: DayName): Weekday {
  return DAY_NAMES.indexOf(day) as Weekday;
}

/** True when the practitioner has working hours on `date`'s weekday (ignores blocks). */
export function practitionerWorksOn(practitioner: DatasetPractitioner, date: LocalDate): boolean {
  const weekday = weekdayOf(date);
  return practitioner.availability.some((a) => a.days.some((d) => dayNameToWeekday(d) === weekday));
}

export interface ResolvedBlock {
  key: string;
  practitionerKey: string;
  /** Inclusive local dates. */
  startDate: LocalDate;
  endDate: LocalDate;
  reason: string;
}

export interface ResolvedAppointment {
  key: string;
  patientKey: string;
  practitionerKey: string;
  serviceKey: string;
  date: LocalDate;
  time: LocalTime;
}

/**
 * Turns relative dates into concrete clinic-local dates for a given anchor day. Throws ConfigError
 * if an appointment does not fit the practitioner's working hours or the service's slot grid.
 */
export function resolveDatasetDates(dataset: SchedulingDataset, anchorDate: LocalDate): { blocks: ResolvedBlock[]; appointments: ResolvedAppointment[] } {
  const blocks: ResolvedBlock[] = dataset.blocks.map((b) => ({
    key: b.key,
    practitionerKey: b.practitionerKey,
    startDate: addDays(anchorDate, b.fromDayOffset),
    endDate: addDays(anchorDate, b.toDayOffset),
    reason: b.reason,
  }));
  const blocked = (practitionerKey: string, date: LocalDate): boolean =>
    blocks.some((b) => b.practitionerKey === practitionerKey && b.startDate <= date && date <= b.endDate);

  const appointments = dataset.appointments.map((a): ResolvedAppointment => {
    const practitioner = dataset.practitioners.find((p) => p.key === a.practitionerKey);
    const service = dataset.services.find((s) => s.key === a.serviceKey);
    if (!practitioner || !service) throw new ConfigError(`Dataset appointment '${a.key}' references unknown entities`);
    let date = anchorDate;
    let found = 0;
    for (let i = 0; i < 366 && found < a.workday; i += 1) {
      date = addDays(date, 1);
      if (practitionerWorksOn(practitioner, date) && !blocked(practitioner.key, date)) found += 1;
    }
    if (found < a.workday) throw new ConfigError(`Dataset appointment '${a.key}': practitioner has no working day #${a.workday}`);
    const start = minutesOfDay(a.time);
    const weekday = weekdayOf(date);
    const fits = practitioner.availability.some(
      (r) =>
        r.days.some((d) => dayNameToWeekday(d) === weekday) &&
        start >= minutesOfDay(r.start) &&
        start + service.durationMinutes <= minutesOfDay(r.end) &&
        (start - minutesOfDay(r.start)) % service.durationMinutes === 0,
    );
    if (!fits) throw new ConfigError(`Dataset appointment '${a.key}' at ${a.time} does not fit the working hours/slot grid of '${a.practitionerKey}' on ${date}`);
    return { key: a.key, patientKey: a.patientKey, practitionerKey: a.practitionerKey, serviceKey: a.serviceKey, date, time: a.time };
  });
  return { blocks, appointments };
}
