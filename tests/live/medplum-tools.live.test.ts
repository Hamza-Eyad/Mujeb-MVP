import { afterAll, describe, expect, it } from 'vitest';
import { AppointmentTools, type ToolTurnContext } from '../../src/agent/tools/appointment-tools.js';
import type { LogFields, Logger } from '../../src/core/logger.js';
import { type LocalDate, addDays, instantToZoned, zonedToInstant } from '../../src/core/zoned-time.js';
import { LIVE_MEDPLUM_ENABLED, LIVE_TENANT, type LiveMedplum, connectLiveMedplum } from '../support/live-medplum.js';

/**
 * Mujeeb's appointment tools end to end against the real Medplum sandbox: development verification,
 * session refs, server-side confirmation, booking / rescheduling / cancellation, conflicts, duplicates and
 * write-ledger reconciliation. No language model — each test plays the model's tool calls and the caller's
 * turns explicitly. Opt-in, never part of `npm test`:
 *
 *   MUJEEB_LIVE_MEDPLUM=1 MEDPLUM_CLIENT_ID=… MEDPLUM_CLIENT_SECRET=… npx vitest run --config vitest.live.config.ts tests/live/medplum-tools.live.test.ts
 *
 * Writes only for patients registered by the test itself; the seeded appointments are read, never changed.
 */

class RecordingLogger implements Logger {
  readonly lines: { level: string; event: string; fields: LogFields }[];
  constructor(lines: RecordingLogger['lines'] = []) {
    this.lines = lines;
  }
  debug(event: string, fields?: LogFields): void {
    this.lines.push({ level: 'debug', event, fields: fields ?? {} });
  }
  info(event: string, fields?: LogFields): void {
    this.lines.push({ level: 'info', event, fields: fields ?? {} });
  }
  warn(event: string, fields?: LogFields): void {
    this.lines.push({ level: 'warn', event, fields: fields ?? {} });
  }
  error(event: string, fields?: LogFields): void {
    this.lines.push({ level: 'error', event, fields: fields ?? {} });
  }
  child(): Logger {
    return new RecordingLogger(this.lines);
  }
}

let sessionSeq = 0;
function session(m: LiveMedplum) {
  const log = new RecordingLogger();
  const tools = new AppointmentTools({
    scheduling: m.guarded,
    tenant: LIVE_TENANT,
    sessionId: `ses_live_${Date.now()}_${(sessionSeq += 1)}`,
    timeZone: m.timeZone,
    log,
    verificationPolicy: 'dev-identifier-dob',
    readTimeoutMs: 15_000,
    writeTimeoutMs: 20_000,
  });
  let userTurn = 0;
  const spoken = new Map<string, string[]>();
  /**
   * A new caller turn; returns a function that plays one model tool call within it. The previous turn ends
   * first, as in a voice session: the caller heard everything the system spoke in it (read-backs, results).
   */
  const turn = (callerUtterance: string) => {
    if (userTurn > 0) tools.onTurnFinalized(`turn-${userTurn}`, true, (spoken.get(`turn-${userTurn}`) ?? []).join(' '));
    userTurn += 1;
    const ctx: ToolTurnContext = { userTurn, callerUtterance, turnId: `turn-${userTurn}`, signal: AbortSignal.timeout(60_000) };
    return async (name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
      const { output, speech } = await tools.execute(name, JSON.stringify(args), ctx);
      if (speech !== undefined) spoken.set(ctx.turnId, [...(spoken.get(ctx.turnId) ?? []), speech]);
      return output;
    };
  };
  return { tools, log, turn };
}

const str = (v: unknown): string => {
  if (typeof v !== 'string') throw new Error(`expected a string, got ${JSON.stringify(v)}`);
  return v;
};
const list = (output: Record<string, unknown>, key: string): Record<string, unknown>[] => {
  const items = output[key];
  if (!Array.isArray(items) || items.length === 0) throw new Error(`no ${key} in ${JSON.stringify(output)}`);
  return items as Record<string, unknown>[];
};
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const today = (m: LiveMedplum): LocalDate => instantToZoned(new Date(), m.timeZone).date;
const tomorrow = (m: LiveMedplum): LocalDate => addDays(today(m), 1);
const nullSlotsQuery = { practitioner_ref: null, date_to: null, part_of_day: null, for_appointment_ref: null };

const connections: Promise<LiveMedplum>[] = [];
const connect = (options?: Parameters<typeof connectLiveMedplum>[0]): Promise<LiveMedplum> => {
  const c = connectLiveMedplum(options);
  connections.push(c);
  return c;
};

describe.skipIf(!LIVE_MEDPLUM_ENABLED)('live: appointment tools on the Medplum sandbox', () => {
  afterAll(async () => {
    let cancelled = 0;
    for (const c of connections) cancelled += (await (await c).cleanup()).cancelled;
    process.stdout.write(`\n[live] tools cleanup: ${cancelled} leftover appointment(s) cancelled\n`);
  });

  it('verifies seeded patients with the development policy and shows only session refs (read-only)', async () => {
    const m = await connect();
    const { turn } = session(m);
    const one = m.dataset.patients.find((p) => p.key === 'patient-one-upcoming');
    const child = m.dataset.patients.find((p) => p.key === 'patient-child');
    if (!one || !child) throw new Error('dataset patients missing');

    const call = turn('رقم هويتي وتاريخ ميلادي');
    expect(await call('find_patient', { national_id: one.nationalId, phone: null, birth_date: '1990-01-01' })).toMatchObject({ status: 'not_verified', attempts_left: 2 });
    const verified = await call('find_patient', { national_id: one.nationalId, phone: null, birth_date: one.birthDate });
    expect(verified).toMatchObject({ status: 'verified', patient: { first_name: one.firstName } });
    // Family phone (local format), resolved by the child's date of birth.
    expect(await call('find_patient', { national_id: null, phone: `0${child.phone.slice(4)}`, birth_date: child.birthDate })).toMatchObject({
      status: 'verified',
      patient: { first_name: child.firstName },
    });

    const patientRef = str((verified['patient'] as Record<string, unknown>)['ref']);
    const appointments = await call('list_patient_appointments', { patient_ref: patientRef });
    expect(appointments).toMatchObject({ status: 'ok', more: false });
    const [seeded] = list(appointments, 'appointments');
    expect(seeded).toMatchObject({ ref: 'A1', doctor: 'فهد العتيبي', service: 'طب الأسرة', time: '17:00' });
    // The model sees short refs only: no Medplum IDs or references anywhere in the tool output.
    expect(JSON.stringify([verified, appointments])).not.toMatch(UUID);
    expect(JSON.stringify([verified, appointments])).not.toMatch(/Patient\/|Appointment\/|Practitioner\//);

    // Refs are bound to this session and to their kind.
    expect(await call('propose_cancellation', { appointment_ref: 'A9', reason: null })).toMatchObject({ status: 'unknown_ref' });
    expect(await call('propose_cancellation', { appointment_ref: patientRef, reason: null })).toMatchObject({ status: 'unknown_ref' });
    const other = session(m).turn('احجز لي');
    expect(await other('list_patient_appointments', { patient_ref: patientRef })).toMatchObject({ status: 'unknown_ref' });

    const doctor = await call('search_clinic_directory', { query: 'دكتورة ريم', kind: 'practitioner', service_ref: null });
    expect(list(doctor, 'results')[0]).toMatchObject({ kind: 'practitioner', name: 'ريم القحطاني', gender: 'female' });
  });

  it('registers, books, reschedules and cancels through server-side confirmation, with Medplum reflecting each step', async () => {
    const m = await connect();
    const { turn } = session(m);
    const { syntheticNationalId } = await import('../support/live-medplum.js');
    const nationalId = syntheticNationalId();

    // Registration: proposal, then confirmation in the caller's next turn only.
    let call = turn('أبي أسجل ملف جديد');
    const proposed = await call('propose_registration', { full_name: 'مريض اختبار الأدوات', national_id: nationalId, phone: '0500000199', birth_date: '1991-02-03', gender: 'female' });
    expect(proposed).toMatchObject({ status: 'confirmation_required', read_back: { national_id: nationalId, phone: '0500000199' } });
    const registration = str(proposed['action_ref']);
    expect(await call('confirm_pending_action', { action_ref: registration, caller_answer: 'yes' })).toMatchObject({ status: 'caller_confirmation_required' });
    call = turn('إيه بس لحظة');
    expect(await call('confirm_pending_action', { action_ref: registration, caller_answer: 'yes' })).toMatchObject({ status: 'confirmation_unclear' });
    call = turn('إيه');
    const registered = await call('confirm_pending_action', { action_ref: registration, caller_answer: 'yes' });
    expect(registered).toMatchObject({ status: 'done', patient: { first_name: 'مريض' } });
    const patientRef = str((registered['patient'] as Record<string, unknown>)['ref']);
    const [record] = await m.system.findPatients(m.ctx(), { nationalId });
    if (!record) throw new Error('registered patient not found in Medplum');
    expect(record).toMatchObject({ birthDate: '1991-02-03', phone: '+966500000199', gender: 'female' });

    // Booking.
    const service = list(await call('search_clinic_directory', { query: 'أطفال', kind: 'service', service_ref: null }), 'results')[0];
    expect(service).toMatchObject({ kind: 'service', name: 'طب الأطفال' });
    const serviceRef = str(service?.['ref']);
    const offered = list(await call('search_available_slots', { ...nullSlotsQuery, service_ref: serviceRef, date_from: tomorrow(m) }), 'slots');
    const [first] = offered;
    const booking = await call('propose_booking', { patient_ref: patientRef, slot_ref: str(first?.['ref']) });
    expect(booking).toMatchObject({ status: 'confirmation_required', read_back: { date: first?.['date'], time: first?.['time'], doctor: first?.['doctor'] } });
    call = turn('تمام');
    const booked = await call('confirm_pending_action', { action_ref: str(booking['action_ref']), caller_answer: 'yes' });
    expect(booked).toMatchObject({ status: 'done', appointment: { date: first?.['date'], time: first?.['time'] } });
    expect(await call('confirm_pending_action', { action_ref: str(booking['action_ref']), caller_answer: 'yes' })).toMatchObject({ status: 'already_used' });
    const appointmentRef = str((booked['appointment'] as Record<string, unknown>)['ref']);
    let stored = await m.system.listAppointments(m.ctx(), { patientId: record.id });
    expect(stored).toHaveLength(1);
    const original = stored[0];
    if (!original) throw new Error('booking not in Medplum');
    expect(instantToZoned(original.start, m.timeZone)).toMatchObject({ date: first?.['date'], time: first?.['time'] });
    expect(list(await call('list_patient_appointments', { patient_ref: patientRef }), 'appointments')[0]).toMatchObject({ ref: appointmentRef });

    // Rescheduling to another time of the same service.
    call = turn('أبي أغيّر الموعد'); // the spoken result ended the booking turn
    const alternatives = list(await call('search_available_slots', { ...nullSlotsQuery, service_ref: serviceRef, date_from: tomorrow(m), for_appointment_ref: appointmentRef }), 'slots');
    const target = alternatives.find((s) => s['date'] !== first?.['date'] || s['time'] !== first?.['time']);
    const reschedule = await call('propose_reschedule', { appointment_ref: appointmentRef, new_slot_ref: str(target?.['ref']) });
    expect(reschedule).toMatchObject({ status: 'confirmation_required', read_back: { to: { date: target?.['date'], time: target?.['time'] } } });
    call = turn('إيه أكد');
    expect(await call('confirm_pending_action', { action_ref: str(reschedule['action_ref']), caller_answer: 'yes' })).toMatchObject({ status: 'done', appointment: { date: target?.['date'], time: target?.['time'] } });
    stored = await m.system.listAppointments(m.ctx(), { patientId: record.id });
    expect(stored.map((a) => a.id)).toEqual([original.id]); // same appointment, new time
    expect(instantToZoned(stored[0]?.start ?? new Date(0), m.timeZone)).toMatchObject({ date: target?.['date'], time: target?.['time'] });
    const freed = await m.system.findAvailability(m.ctx(), { serviceId: original.serviceId, practitionerIds: [original.practitionerId], from: original.start, to: original.end, limit: 1 });
    expect(freed.slots.map((s) => s.start.getTime())).toContain(original.start.getTime());

    // Cancellation.
    call = turn('أبي ألغي الموعد');
    const cancel = await call('propose_cancellation', { appointment_ref: appointmentRef, reason: null });
    expect(cancel).toMatchObject({ status: 'confirmation_required' });
    call = turn('لا خلاص');
    expect(await call('confirm_pending_action', { action_ref: str(cancel['action_ref']), caller_answer: 'yes' })).toMatchObject({ status: 'declined' });
    expect(await m.system.listAppointments(m.ctx(), { patientId: record.id })).toHaveLength(1);
    const cancelAgain = await call('propose_cancellation', { appointment_ref: appointmentRef, reason: null });
    call = turn('ألغيه');
    expect(await call('confirm_pending_action', { action_ref: str(cancelAgain['action_ref']), caller_answer: 'yes' })).toMatchObject({ status: 'done', cancelled: { ref: appointmentRef } });
    expect(await m.system.listAppointments(m.ctx(), { patientId: record.id })).toEqual([]);
    expect((await m.system.getAppointment(m.ctx(), original.id)).status).toBe('cancelled');

    // A second registration of the same national ID (another call) is refused by Medplum's conditional create.
    const again = session(m);
    let second = again.turn('سجلني');
    const duplicate = await second('propose_registration', { full_name: 'اسم ثاني', national_id: nationalId, phone: '0500000199', birth_date: '1980-01-01', gender: 'male' });
    second = again.turn('إيه');
    expect(await second('confirm_pending_action', { action_ref: str(duplicate['action_ref']), caller_answer: 'yes' })).toMatchObject({ status: 'already_exists' });
    expect(await m.system.findPatients(m.ctx(), { nationalId })).toHaveLength(1);
  });

  it('refuses a slot taken between proposal and confirmation (validated by Medplum at execution)', async () => {
    const m = await connect();
    const caller = await m.registerTestPatient('تعارض');
    const rival = await m.registerTestPatient('منافس');
    const { turn } = session(m);
    let call = turn('أبي موعد جلدية');
    const verified = await call('find_patient', { national_id: caller.nationalId, phone: null, birth_date: caller.birthDate });
    const patientRef = str((verified['patient'] as Record<string, unknown>)['ref']);
    const service = list(await call('search_clinic_directory', { query: 'جلدية', kind: 'service', service_ref: null }), 'results')[0];
    const [slot] = list(await call('search_available_slots', { ...nullSlotsQuery, service_ref: str(service?.['ref']), date_from: addDays(m.anchorDate, 5) }), 'slots');
    const proposal = await call('propose_booking', { patient_ref: patientRef, slot_ref: str(slot?.['ref']) });

    // Someone else takes that exact time meanwhile.
    const start = zonedToInstant(str(slot?.['date']), str(slot?.['time']), m.timeZone);
    const { entries } = await m.system.searchDirectory(m.ctx(), { text: 'الجلدية', kind: 'service', limit: 1 });
    const serviceId = entries[0]?.kind === 'service' ? entries[0].service.id : '';
    const same = (await m.system.findAvailability(m.ctx(), { serviceId, from: start, to: new Date(start.getTime() + 60_000), limit: 5 })).slots.find((s) => s.start.getTime() === start.getTime());
    if (!same) throw new Error('offered slot not found again');
    await m.guarded.book(m.ctx(), { patientId: rival.record.id, slot: same, idempotencyKey: `rival-${Date.now()}` });

    call = turn('إيه');
    expect(await call('confirm_pending_action', { action_ref: str(proposal['action_ref']), caller_answer: 'yes' })).toMatchObject({ status: 'slot_unavailable' });
    expect(await m.system.listAppointments(m.ctx(), { patientId: caller.record.id })).toEqual([]);
  });

  it('reconciles a write whose reply was lost by reading Medplum, and never retries it', async () => {
    let mode: 'pass' | 'lose-reply' | 'drop-request' = 'pass';
    let booksReachingServer = 0;
    const flaky: typeof fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (init?.method === 'POST' && url.endsWith('/Appointment/$book')) {
        const current = mode;
        mode = 'pass';
        if (current === 'drop-request') throw new TypeError('fetch failed (simulated: connection lost before sending)');
        booksReachingServer += 1;
        const response = await fetch(input, init); // Medplum applies the booking…
        if (current === 'lose-reply') {
          await response.body?.cancel();
          throw new TypeError('fetch failed (simulated: connection lost before the reply)'); // …but the reply never arrives
        }
        return response;
      }
      return fetch(input, init);
    };
    const m = await connect({ fetch: flaky });
    const caller = await m.registerTestPatient('مطابقة');
    const { turn, log } = session(m);
    let call = turn('أبي موعد');
    const patientRef = str(((await call('find_patient', { national_id: caller.nationalId, phone: null, birth_date: caller.birthDate }))['patient'] as Record<string, unknown>)['ref']);
    const service = list(await call('search_clinic_directory', { query: 'طب الأسرة', kind: 'service', service_ref: null }), 'results')[0];
    const [slotA, slotB] = list(await call('search_available_slots', { ...nullSlotsQuery, service_ref: str(service?.['ref']), date_from: tomorrow(m) }), 'slots');

    // Applied, reply lost → unknown → reconciled by reading → done, exactly one appointment.
    const first = await call('propose_booking', { patient_ref: patientRef, slot_ref: str(slotA?.['ref']) });
    mode = 'lose-reply';
    call = turn('إيه');
    expect(await call('confirm_pending_action', { action_ref: str(first['action_ref']), caller_answer: 'yes' })).toMatchObject({ status: 'done', appointment: { date: slotA?.['date'], time: slotA?.['time'] } });
    expect(log.lines.map((l) => l.event)).toEqual(expect.arrayContaining(['write.outcome_unknown', 'write.reconciled']));
    expect(log.lines.find((l) => l.event === 'write.reconciled')?.fields).toMatchObject({ applied: true, status: 'succeeded' });
    expect(await m.system.listAppointments(m.ctx(), { patientId: caller.record.id })).toHaveLength(1);

    // Never sent → unknown → reconciled → not applied; nothing new in Medplum.
    call = turn('أبي موعد ثاني');
    const second = await call('propose_booking', { patient_ref: patientRef, slot_ref: str(slotB?.['ref']) });
    mode = 'drop-request';
    call = turn('إيه');
    expect(await call('confirm_pending_action', { action_ref: str(second['action_ref']), caller_answer: 'yes' })).toMatchObject({ status: 'not_applied' });
    expect(await m.system.listAppointments(m.ctx(), { patientId: caller.record.id })).toHaveLength(1);
    expect(booksReachingServer).toBe(1); // no automatic retry of a write
  });
});
