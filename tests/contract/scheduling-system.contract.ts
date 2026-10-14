import { afterEach, describe, expect, it } from 'vitest';
import type { SchedulingDataset } from '../../src/contracts/scheduling-dataset.js';
import { CancelledError, ProviderError, SchedulingError } from '../../src/core/errors.js';
import { nationalIdChecksumValid } from '../../src/core/identifiers.js';
import { type LocalDate, addDays, instantToZoned, minutesOfDay, zonedToInstant } from '../../src/core/zoned-time.js';
import type {
  AppointmentRecord,
  AvailableSlot,
  PatientRecord,
  PractitionerInfo,
  SchedulingContext,
  SchedulingSystem,
  ServiceInfo,
} from '../../src/ports/scheduling.js';

/**
 * Behaviour every `SchedulingSystem` adapter must show. Runs against the in-memory adapter on every
 * `npm test`, and against a sandbox HIS from the gated live suite. Entities are always found through
 * the contract itself (search by name / national ID), never through adapter IDs.
 *
 * Reads use the dataset's patients and appointments. Writes (book, reschedule, cancel) use a patient
 * registered by the test itself and appointments it booked, so they never change the dataset's scenarios —
 * on a long-lived sandbox HIS the seeded appointments stay intact.
 */

export interface SchedulingContractFixture {
  system: SchedulingSystem;
  /** The synthetic dataset the system was loaded/seeded with. */
  dataset: SchedulingDataset;
  /** Clinic-local day the dataset's relative dates were resolved against. */
  anchorDate: LocalDate;
  now: () => Date;
  ctx: (signal?: AbortSignal) => SchedulingContext;
  /** A context for a tenant this system does not serve. */
  foreignCtx: () => SchedulingContext;
  /** A shared, long-lived system (sandbox HIS): every test cancels the appointments it booked when it ends. */
  persistent?: boolean;
}

/** Phone of the patients the contract registers itself (outside the dataset's numbers). */
const CONTRACT_PATIENT_PHONE = '+966500000198';
let nationalIdSeq = 0;

/** A fresh, well-formed national ID that fails the checksum (never a real person), unique per run. */
function syntheticNationalId(): string {
  const body = `1${String((Date.now() + (nationalIdSeq += 1)) % 100_000_000).padStart(8, '0')}`;
  for (let check = 0; check < 10; check += 1) {
    const id = `${body}${check}`;
    if (!nationalIdChecksumValid(id)) return id;
  }
  throw new Error('unreachable: at most one check digit is valid');
}

export function describeSchedulingContract(label: string, createFixture: () => SchedulingContractFixture | Promise<SchedulingContractFixture>): void {
  describe(`SchedulingSystem contract: ${label}`, () => {
    let keySeq = 0;
    const key = (): string => `contract-${Date.now()}-${(keySeq += 1)}`;
    let cleanups: (() => Promise<void>)[] = [];
    afterEach(async () => {
      const pending = cleanups;
      cleanups = [];
      for (const cleanup of pending) await cleanup();
    });

    async function setup() {
      const f = await createFixture();
      const ownPatients: PatientRecord[] = [];
      if (f.persistent) {
        cleanups.push(async () => {
          for (const p of ownPatients) {
            for (const a of await f.system.listAppointments(f.ctx(), { patientId: p.id })) {
              await f.system.cancel(f.ctx(), { appointmentId: a.id, reason: 'contract test cleanup', idempotencyKey: key() }).catch(() => undefined);
            }
          }
        });
      }
      const tz = f.dataset.clinic.timezone;
      const ds = f.dataset;
      const byKey = <T extends { key: string }>(items: readonly T[], k: string): T => {
        const found = items.find((i) => i.key === k);
        if (!found) throw new Error(`dataset has no '${k}'`);
        return found;
      };
      const service = async (datasetKey: string): Promise<ServiceInfo> => {
        const name = byKey(ds.services, datasetKey).name;
        const result = await f.system.searchDirectory(f.ctx(), { text: name, kind: 'service', limit: 5 });
        const entry = result.entries.find((e) => e.kind === 'service' && e.service.name === name);
        if (entry?.kind !== 'service') throw new Error(`service '${name}' not found through search`);
        return entry.service;
      };
      const practitioner = async (datasetKey: string): Promise<PractitionerInfo> => {
        const name = byKey(ds.practitioners, datasetKey).name;
        const result = await f.system.searchDirectory(f.ctx(), { text: name, kind: 'practitioner', limit: 5 });
        const entry = result.entries.find((e) => e.kind === 'practitioner' && e.practitioner.name === name);
        if (entry?.kind !== 'practitioner') throw new Error(`practitioner '${name}' not found through search`);
        return entry.practitioner;
      };
      const patient = async (datasetKey: string): Promise<PatientRecord> => {
        const [found] = await f.system.findPatients(f.ctx(), { nationalId: byKey(ds.patients, datasetKey).nationalId });
        if (!found) throw new Error(`patient '${datasetKey}' not found by national ID`);
        return found;
      };
      /** [anchor + fromDay 00:00, anchor + fromDay + days 00:00) in clinic time. */
      const window = (fromDay: number, days: number): { from: Date; to: Date } => ({
        from: zonedToInstant(addDays(f.anchorDate, fromDay), '00:00', tz),
        to: zonedToInstant(addDays(f.anchorDate, fromDay + days), '00:00', tz),
      });
      const slots = async (serviceKey: string, options?: { practitionerKey?: string; fromDay?: number; days?: number; limit?: number; ignoreAppointmentId?: string }): Promise<AvailableSlot[]> => {
        const svc = await service(serviceKey);
        const practitionerIds = options?.practitionerKey ? [(await practitioner(options.practitionerKey)).id] : undefined;
        const result = await f.system.findAvailability(f.ctx(), {
          serviceId: svc.id,
          ...(practitionerIds ? { practitionerIds } : {}),
          ...window(options?.fromDay ?? 1, options?.days ?? 7),
          limit: options?.limit ?? 50,
          ...(options?.ignoreAppointmentId ? { ignoreAppointmentId: options.ignoreAppointmentId } : {}),
        });
        return [...result.slots];
      };
      const firstSlot = async (serviceKey: string, practitionerKey?: string): Promise<AvailableSlot> => {
        const [slot] = await slots(serviceKey, practitionerKey ? { practitionerKey } : {});
        if (!slot) throw new Error(`no free slot for ${serviceKey}`);
        return slot;
      };
      const upcoming = async (patientKey: string): Promise<readonly AppointmentRecord[]> =>
        f.system.listAppointments(f.ctx(), { patientId: (await patient(patientKey)).id });
      /** A patient only this test writes for (registered now). */
      const ownPatient = async (): Promise<PatientRecord> => {
        const created = await f.system.registerPatient(f.ctx(), {
          patient: { fullName: 'مريض اختبار العقد', nationalId: syntheticNationalId(), phone: CONTRACT_PATIENT_PHONE, birthDate: '1990-01-01', gender: 'male' },
          idempotencyKey: key(),
        });
        ownPatients.push(created);
        return created;
      };
      /** A booked family-medicine appointment (dr-fahad) of a patient only this test uses. */
      const ownAppointment = async (): Promise<AppointmentRecord> => {
        const who = await ownPatient();
        return f.system.book(f.ctx(), { patientId: who.id, slot: await firstSlot('family-medicine', 'dr-fahad'), idempotencyKey: key() });
      };
      const appointmentsOf = (patientId: string): Promise<readonly AppointmentRecord[]> => f.system.listAppointments(f.ctx(), { patientId });
      return { f, tz, ds, byKey, service, practitioner, patient, window, slots, firstSlot, upcoming, ownPatient, ownAppointment, appointmentsOf };
    }

    const schedulingKind = (kind: string) => ({ name: 'SchedulingError', kind }) as const;
    const starts = (list: readonly { start: Date }[]): number[] => list.map((s) => s.start.getTime());

    // ─────────────────────────────── directory ───────────────────────────────

    describe('directory', () => {
      it('finds a service by Arabic spelling variants and English aliases', async () => {
        const { f, ds, byKey } = await setup();
        const expected = byKey(ds.services, 'dermatology').name;
        for (const text of ['جلدية', 'الجلديه', 'الأمراض الجلدية', 'Dermatology']) {
          const { entries } = await f.system.searchDirectory(f.ctx(), { text, kind: 'service', limit: 5 });
          expect(entries[0], text).toMatchObject({ kind: 'service', service: { name: expected } });
        }
      });

      it('finds a practitioner despite titles, hamza/alef-maqsura variants and English spelling', async () => {
        const { f, ds, byKey } = await setup();
        const cases: [string, string][] = [
          ['دكتورة سارة', 'dr-sara'],
          ['د. ريم القحطانى', 'dr-reem'],
          ['reem', 'dr-reem'],
          ['الدكتور فهد', 'dr-fahad'],
        ];
        for (const [text, k] of cases) {
          const { entries } = await f.system.searchDirectory(f.ctx(), { text, kind: 'practitioner', limit: 5 });
          expect(entries[0], text).toMatchObject({ kind: 'practitioner', practitioner: { name: byKey(ds.practitioners, k).name } });
        }
      });

      it('filters practitioners by service and reports their gender and services', async () => {
        const { f, ds, service } = await setup();
        const pediatrics = await service('pediatrics');
        const { entries } = await f.system.searchDirectory(f.ctx(), { kind: 'practitioner', serviceId: pediatrics.id, limit: 10 });
        const expected = ds.practitioners.filter((p) => p.serviceKeys.includes('pediatrics'));
        expect(entries.map((e) => (e.kind === 'practitioner' ? e.practitioner.name : '')).sort()).toEqual(expected.map((p) => p.name).sort());
        for (const e of entries) {
          if (e.kind !== 'practitioner') throw new Error('expected practitioners only');
          expect(e.practitioner.services.map((s) => s.id)).toContain(pediatrics.id);
          expect(['female', 'male']).toContain(e.practitioner.gender);
        }
      });

      it('lists everything when no text is given, honouring limit and hasMore', async () => {
        const { f, ds } = await setup();
        const page = await f.system.searchDirectory(f.ctx(), { kind: 'practitioner', limit: 2 });
        expect(page.entries).toHaveLength(2);
        expect(page.hasMore).toBe(true);
        const all = await f.system.searchDirectory(f.ctx(), { kind: 'practitioner', limit: 50 });
        expect(all.entries.length).toBeGreaterThanOrEqual(ds.practitioners.length);
        expect(all.hasMore).toBe(false);
      });

      it('returns no entries for unrelated text', async () => {
        const { f } = await setup();
        const result = await f.system.searchDirectory(f.ctx(), { text: 'جراحة القلب المفتوح', kind: 'any', limit: 5 });
        expect(result.entries).toEqual([]);
      });

      it('rejects an unknown service filter and an invalid limit', async () => {
        const { f } = await setup();
        await expect(f.system.searchDirectory(f.ctx(), { kind: 'practitioner', serviceId: 'unknown-service', limit: 5 })).rejects.toMatchObject(schedulingKind('not_found'));
        await expect(f.system.searchDirectory(f.ctx(), { kind: 'any', limit: 0 })).rejects.toMatchObject(schedulingKind('invalid_request'));
      });
    });

    // ─────────────────────────────── availability ───────────────────────────────

    describe('availability', () => {
      it('returns future slots of the requested service in order, on its duration and working hours', async () => {
        const { f, tz, ds, byKey, slots } = await setup();
        const svc = byKey(ds.services, 'family-medicine');
        const doctor = byKey(ds.practitioners, 'dr-fahad');
        const list = await slots('family-medicine', { limit: 10 });
        expect(list).toHaveLength(10);
        const now = f.now().getTime();
        let previous = 0;
        for (const slot of list) {
          expect(slot.start.getTime()).toBeGreaterThan(now);
          expect(slot.start.getTime()).toBeGreaterThanOrEqual(previous);
          previous = slot.start.getTime();
          expect(slot.end.getTime() - slot.start.getTime()).toBe(svc.durationMinutes * 60_000);
          expect(slot).toMatchObject({ serviceName: svc.name, practitionerName: doctor.name });
          expect(typeof slot.token).toBe('string');
          expect(slot.token.length).toBeGreaterThan(0);
          const local = instantToZoned(slot.start, tz).minutes;
          const fits = doctor.availability.some((a) => local >= minutesOfDay(a.start) && local + svc.durationMinutes <= minutesOfDay(a.end));
          expect(fits).toBe(true);
        }
      });

      it('honours limit and reports hasMore', async () => {
        const { f, service, window } = await setup();
        const svc = await service('pediatrics');
        const result = await f.system.findAvailability(f.ctx(), { serviceId: svc.id, ...window(1, 7), limit: 3 });
        expect(result.slots).toHaveLength(3);
        expect(result.hasMore).toBe(true);
      });

      it('offers a slot by its start: inside [from, to) even when it ends after `to`, never when it starts before `from`', async () => {
        const { f, service, firstSlot } = await setup();
        const svc = await service('dermatology');
        const slot = await firstSlot('dermatology');
        const minute = 60_000;
        const around = async (from: number, to: number) =>
          starts((await f.system.findAvailability(f.ctx(), { serviceId: svc.id, from: new Date(from), to: new Date(to), limit: 5 })).slots);
        expect(await around(slot.start.getTime(), slot.start.getTime() + minute)).toContain(slot.start.getTime());
        expect(await around(slot.start.getTime() + minute, slot.end.getTime())).not.toContain(slot.start.getTime());
      });

      it('offers any practitioner of the service unless restricted', async () => {
        const { slots, ds, byKey } = await setup();
        const names = new Set((await slots('pediatrics', { days: 7 })).map((s) => s.practitionerName));
        expect(names).toEqual(new Set(ds.practitioners.filter((p) => p.serviceKeys.includes('pediatrics')).map((p) => p.name)));
        const onlyReem = await slots('pediatrics', { practitionerKey: 'dr-reem' });
        expect(new Set(onlyReem.map((s) => s.practitionerName))).toEqual(new Set([byKey(ds.practitioners, 'dr-reem').name]));
      });

      it('never offers time inside a block (leave), and resumes after it', async () => {
        const { ds, slots } = await setup();
        const leave = ds.blocks.find((b) => b.practitionerKey === 'dr-sara');
        if (!leave) throw new Error('dataset needs a leave block for dr-sara');
        const during = await slots('dermatology', { fromDay: leave.fromDayOffset, days: leave.toDayOffset - leave.fromDayOffset + 1 });
        expect(during).toEqual([]);
        const after = await slots('dermatology', { fromDay: leave.toDayOffset + 1, days: 7 });
        expect(after.length).toBeGreaterThan(0);
      });

      it("excludes booked times, but offers an appointment's own time when it is ignored (rescheduling)", async () => {
        const { upcoming, slots } = await setup();
        const [appointment] = await upcoming('patient-one-upcoming');
        if (!appointment) throw new Error('dataset needs an appointment for patient-one-upcoming');
        const plain = await slots('family-medicine', { practitionerKey: 'dr-fahad', days: 14 });
        expect(starts(plain)).not.toContain(appointment.start.getTime());
        const ignoring = await slots('family-medicine', { practitionerKey: 'dr-fahad', days: 14, ignoreAppointmentId: appointment.id });
        expect(starts(ignoring)).toContain(appointment.start.getTime());
      });

      it('rejects windows that are empty or too long, and practitioners who do not offer the service', async () => {
        const { f, service, practitioner, window } = await setup();
        const family = await service('family-medicine');
        const sara = await practitioner('dr-sara');
        const w = window(1, 1);
        await expect(f.system.findAvailability(f.ctx(), { serviceId: family.id, from: w.to, to: w.from, limit: 5 })).rejects.toMatchObject(schedulingKind('invalid_request'));
        await expect(f.system.findAvailability(f.ctx(), { serviceId: family.id, ...window(1, 15), limit: 5 })).rejects.toMatchObject(schedulingKind('invalid_request'));
        await expect(f.system.findAvailability(f.ctx(), { serviceId: family.id, practitionerIds: [sara.id], ...w, limit: 5 })).rejects.toMatchObject(schedulingKind('invalid_request'));
        await expect(f.system.findAvailability(f.ctx(), { serviceId: 'unknown-service', ...w, limit: 5 })).rejects.toMatchObject(schedulingKind('not_found'));
      });
    });

    // ─────────────────────────────── patients ───────────────────────────────

    describe('patients', () => {
      it('finds a patient by national ID with the data needed for verification', async () => {
        const { f, ds, byKey } = await setup();
        const expected = byKey(ds.patients, 'patient-one-upcoming');
        const found = await f.system.findPatients(f.ctx(), { nationalId: expected.nationalId });
        expect(found).toHaveLength(1);
        expect(found[0]).toMatchObject({ fullName: expected.fullName, firstName: expected.firstName, birthDate: expected.birthDate, gender: expected.gender });
      });

      it('returns every patient sharing a phone number (family phone)', async () => {
        const { f, ds, byKey } = await setup();
        const mother = byKey(ds.patients, 'patient-mother');
        const found = await f.system.findPatients(f.ctx(), { phone: mother.phone });
        expect(found.map((p) => p.fullName).sort()).toEqual(ds.patients.filter((p) => p.phone === mother.phone).map((p) => p.fullName).sort());
        expect(found.length).toBeGreaterThanOrEqual(2);
      });

      it('requires every given field to match', async () => {
        const { f, ds, byKey } = await setup();
        const found = await f.system.findPatients(f.ctx(), { nationalId: byKey(ds.patients, 'patient-mother').nationalId, phone: byKey(ds.patients, 'patient-one-upcoming').phone });
        expect(found).toEqual([]);
      });

      it('returns no candidates for unknown identifiers, and rejects empty or non-canonical lookups', async () => {
        const { f } = await setup();
        expect(await f.system.findPatients(f.ctx(), { nationalId: '1999999990' })).toEqual([]);
        await expect(f.system.findPatients(f.ctx(), {})).rejects.toMatchObject(schedulingKind('invalid_request'));
        await expect(f.system.findPatients(f.ctx(), { phone: '0500000101' })).rejects.toMatchObject(schedulingKind('invalid_request'));
      });

      it('registers a new patient once and reports duplicates as already_exists', async () => {
        const { f } = await setup();
        const nationalId = syntheticNationalId();
        const created = await f.system.registerPatient(f.ctx(), {
          patient: { fullName: 'سلمان خالد العمري', nationalId, phone: '+966500000106', birthDate: '1995-04-30', gender: 'male' },
          idempotencyKey: key(),
        });
        expect(created).toMatchObject({ fullName: 'سلمان خالد العمري', firstName: 'سلمان', birthDate: '1995-04-30', nationalId });
        expect((await f.system.findPatients(f.ctx(), { nationalId })).map((p) => p.id)).toEqual([created.id]);
        await expect(
          f.system.registerPatient(f.ctx(), {
            patient: { fullName: 'اسم آخر', nationalId, phone: '+966500000107', birthDate: '1990-01-01', gender: 'female' },
            idempotencyKey: key(),
          }),
        ).rejects.toMatchObject(schedulingKind('already_exists'));
      });
    });

    // ─────────────────────────────── appointments ───────────────────────────────

    describe('appointments', () => {
      it('lists upcoming appointments earliest first', async () => {
        const { f, ds, upcoming } = await setup();
        const list = await upcoming('patient-two-upcoming');
        const expected = ds.appointments.filter((a) => a.patientKey === 'patient-two-upcoming');
        expect(list).toHaveLength(expected.length);
        expect(starts(list)).toEqual([...starts(list)].sort((a, b) => a - b));
        for (const a of list) {
          expect(a.status).toBe('booked');
          expect(a.start.getTime()).toBeGreaterThan(f.now().getTime());
        }
        expect(new Set(list.map((a) => a.practitionerName))).toEqual(
          new Set(expected.map((e) => ds.practitioners.find((p) => p.key === e.practitionerKey)?.name)),
        );
        expect(await upcoming('patient-no-appointments')).toEqual([]);
      });

      it('reports unknown appointments and patients as not_found', async () => {
        const { f } = await setup();
        await expect(f.system.getAppointment(f.ctx(), 'unknown-appointment')).rejects.toMatchObject(schedulingKind('not_found'));
        await expect(f.system.listAppointments(f.ctx(), { patientId: 'unknown-patient' })).rejects.toMatchObject(schedulingKind('not_found'));
      });
    });

    // ─────────────────────────────── booking ───────────────────────────────

    describe('booking', () => {
      it('books a free slot, which then stops being offered', async () => {
        const { f, ownPatient, firstSlot, slots, appointmentsOf } = await setup();
        const who = await ownPatient();
        const slot = await firstSlot('family-medicine');
        const booked = await f.system.book(f.ctx(), { patientId: who.id, slot, idempotencyKey: key() });
        expect(booked).toMatchObject({ patientId: who.id, status: 'booked', practitionerId: slot.practitionerId, serviceId: slot.serviceId });
        expect(booked.start.getTime()).toBe(slot.start.getTime());
        expect((await f.system.getAppointment(f.ctx(), booked.id)).status).toBe('booked');
        expect((await appointmentsOf(who.id)).map((a) => a.id)).toEqual([booked.id]);
        const again = await slots('family-medicine', { practitionerKey: 'dr-fahad' });
        expect(starts(again)).not.toContain(slot.start.getTime());
      });

      it('validates availability at execution time: a slot taken after it was offered is rejected', async () => {
        const { f, ownPatient, firstSlot } = await setup();
        const slot = await firstSlot('dermatology');
        const other = await ownPatient();
        await f.system.book(f.ctx(), { patientId: other.id, slot, idempotencyKey: key() });
        const who = await ownPatient();
        await expect(f.system.book(f.ctx(), { patientId: who.id, slot, idempotencyKey: key() })).rejects.toMatchObject(schedulingKind('slot_unavailable'));
      });

      it('lets exactly one of two concurrent bookings of the same slot succeed', async () => {
        const { f, ownPatient, firstSlot } = await setup();
        const slot = await firstSlot('pediatrics', 'dr-khalid');
        const [a, b] = [await ownPatient(), await ownPatient()];
        const results = await Promise.allSettled([
          f.system.book(f.ctx(), { patientId: a.id, slot, idempotencyKey: key() }),
          f.system.book(f.ctx(), { patientId: b.id, slot, idempotencyKey: key() }),
        ]);
        expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
        const rejected = results.find((r) => r.status === 'rejected');
        expect(rejected?.status === 'rejected' ? rejected.reason : undefined).toMatchObject(schedulingKind('slot_unavailable'));
      });

      it('rejects a booking for an unknown patient', async () => {
        const { f, firstSlot } = await setup();
        const slot = await firstSlot('family-medicine');
        await expect(f.system.book(f.ctx(), { patientId: 'unknown-patient', slot, idempotencyKey: key() })).rejects.toMatchObject(schedulingKind('not_found'));
      });

      it('returns the first result when a write is repeated with the same idempotency key', async (test) => {
        const { f, ownPatient, firstSlot, appointmentsOf } = await setup();
        if (!f.system.capabilities.idempotencyKeys) test.skip();
        const who = await ownPatient();
        const slot = await firstSlot('family-medicine');
        const k = key();
        const first = await f.system.book(f.ctx(), { patientId: who.id, slot, idempotencyKey: k });
        const second = await f.system.book(f.ctx(), { patientId: who.id, slot, idempotencyKey: k });
        expect(second.id).toBe(first.id);
        expect(await appointmentsOf(who.id)).toHaveLength(1);
      });
    });

    // ─────────────────────────────── reschedule / cancel ───────────────────────────────

    describe('reschedule and cancel', () => {
      it('moves an appointment to a new time of the same service and frees the old time', async () => {
        const { f, ownAppointment, slots } = await setup();
        const appointment = await ownAppointment();
        const candidates = await slots('family-medicine', { practitionerKey: 'dr-fahad', ignoreAppointmentId: appointment.id });
        const target = candidates.find((s) => s.start.getTime() !== appointment.start.getTime());
        if (!target) throw new Error('no alternative slot');
        const moved = await f.system.reschedule(f.ctx(), { appointmentId: appointment.id, newSlot: target, idempotencyKey: key() });
        expect(moved).toMatchObject({ id: appointment.id, status: 'booked', serviceId: appointment.serviceId });
        expect(moved.start.getTime()).toBe(target.start.getTime());
        if (appointment.version !== undefined) expect(moved.version).not.toBe(appointment.version);
        const after = await slots('family-medicine', { practitionerKey: 'dr-fahad', days: 14 });
        expect(starts(after)).toContain(appointment.start.getTime());
        expect(starts(after)).not.toContain(target.start.getTime());
      });

      it('refuses to change the service, and validates the new time at execution', async () => {
        const { f, ownAppointment, ownPatient, slots } = await setup();
        const appointment = await ownAppointment();
        const [otherService] = await slots('pediatrics');
        if (!otherService) throw new Error('no pediatrics slot');
        await expect(f.system.reschedule(f.ctx(), { appointmentId: appointment.id, newSlot: otherService, idempotencyKey: key() })).rejects.toMatchObject(
          schedulingKind('invalid_request'),
        );

        const candidates = await slots('family-medicine', { practitionerKey: 'dr-fahad', ignoreAppointmentId: appointment.id });
        const target = candidates.find((s) => s.start.getTime() !== appointment.start.getTime());
        if (!target) throw new Error('no alternative slot');
        const someoneElse = await ownPatient();
        await f.system.book(f.ctx(), { patientId: someoneElse.id, slot: target, idempotencyKey: key() });
        await expect(f.system.reschedule(f.ctx(), { appointmentId: appointment.id, newSlot: target, idempotencyKey: key() })).rejects.toMatchObject(
          schedulingKind('slot_unavailable'),
        );
        expect((await f.system.getAppointment(f.ctx(), appointment.id)).start.getTime()).toBe(appointment.start.getTime());
      });

      it('cancels an appointment and frees its time', async () => {
        const { f, ownAppointment, appointmentsOf, slots } = await setup();
        const appointment = await ownAppointment();
        const cancelled = await f.system.cancel(f.ctx(), { appointmentId: appointment.id, reason: 'طلب المريض', idempotencyKey: key() });
        expect(cancelled).toMatchObject({ id: appointment.id, status: 'cancelled' });
        if (appointment.version !== undefined) expect(cancelled.version).not.toBe(appointment.version);
        expect((await appointmentsOf(appointment.patientId)).map((a) => a.id)).not.toContain(appointment.id);
        expect(starts(await slots('family-medicine', { practitionerKey: 'dr-fahad', days: 14 }))).toContain(appointment.start.getTime());
      });

      it('refuses to cancel or reschedule an appointment that is already cancelled', async () => {
        const { f, ownAppointment, slots } = await setup();
        const appointment = await ownAppointment();
        await f.system.cancel(f.ctx(), { appointmentId: appointment.id, idempotencyKey: key() });
        await expect(f.system.cancel(f.ctx(), { appointmentId: appointment.id, idempotencyKey: key() })).rejects.toMatchObject(schedulingKind('invalid_state'));
        const [slot] = await slots('family-medicine');
        if (!slot) throw new Error('no family-medicine slot');
        await expect(f.system.reschedule(f.ctx(), { appointmentId: appointment.id, newSlot: slot, idempotencyKey: key() })).rejects.toMatchObject(
          schedulingKind('invalid_state'),
        );
      });
    });

    // ─────────────────────────────── context ───────────────────────────────

    describe('context', () => {
      it('rejects requests for a tenant it does not serve', async () => {
        const { f } = await setup();
        const error = await f.system.searchDirectory(f.foreignCtx(), { kind: 'any', limit: 5 }).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(ProviderError);
        expect(error).toMatchObject({ kind: 'auth', retryable: false });
      });

      it('rejects with the abort reason when the signal is already aborted', async () => {
        const { f } = await setup();
        const controller = new AbortController();
        controller.abort(new CancelledError('caller_hung_up'));
        await expect(f.system.searchDirectory(f.ctx(controller.signal), { kind: 'any', limit: 5 })).rejects.toBeInstanceOf(CancelledError);
      });

      it('signals business outcomes with SchedulingError naming the system', async () => {
        const { f } = await setup();
        const error = await f.system.getAppointment(f.ctx(), 'unknown-appointment').catch((e: unknown) => e);
        expect(error).toBeInstanceOf(SchedulingError);
        expect(error).toMatchObject({ system: f.system.name });
      });
    });
  });
}
