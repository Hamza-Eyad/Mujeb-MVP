import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MemorySchedulingSystem } from '../../src/adapters/fakes/memory-scheduling.js';
import { AppointmentTools, type AppointmentToolsOptions, type ToolTurnContext } from '../../src/agent/tools/appointment-tools.js';
import { type SchedulingDataset, parseSchedulingDataset } from '../../src/contracts/scheduling-dataset.js';
import { CancelledError, ProviderError } from '../../src/core/errors.js';
import type { LogFields, Logger } from '../../src/core/logger.js';

/**
 * AppointmentTools end to end against the in-memory scheduling system. No language model: each test
 * plays the model's tool calls and the caller's turns explicitly.
 */

const NOW = new Date('2026-10-11T05:00:00Z'); // Sunday 08:00 in Riyadh
const TODAY = '2026-10-11';
const TENANT = { tenantId: 'demo', agentId: 'demo-clinic' };
const dataset = (): SchedulingDataset => parseSchedulingDataset(JSON.parse(readFileSync('config/test-data/demo-clinic.dataset.json', 'utf8')));

class RecordingLogger implements Logger {
  readonly lines: { level: string; event: string; fields: LogFields }[] = [];
  constructor(private readonly bindings: LogFields = {}) {}
  debug(event: string, fields?: LogFields): void {
    this.lines.push({ level: 'debug', event, fields: { ...this.bindings, ...fields } });
  }
  info(event: string, fields?: LogFields): void {
    this.lines.push({ level: 'info', event, fields: { ...this.bindings, ...fields } });
  }
  warn(event: string, fields?: LogFields): void {
    this.lines.push({ level: 'warn', event, fields: { ...this.bindings, ...fields } });
  }
  error(event: string, fields?: LogFields): void {
    this.lines.push({ level: 'error', event, fields: { ...this.bindings, ...fields } });
  }
  child(bindings: LogFields): Logger {
    const child = new RecordingLogger({ ...this.bindings, ...bindings });
    (child as { lines: RecordingLogger['lines'] }).lines = this.lines;
    return child;
  }
}

function setup(options?: { latencyMs?: number; tools?: Partial<AppointmentToolsOptions> }) {
  const system = new MemorySchedulingSystem({ tenantId: TENANT.tenantId, dataset: dataset(), now: () => NOW, ...(options?.latencyMs ? { latencyMs: options.latencyMs } : {}) });
  const log = new RecordingLogger();
  const tools = new AppointmentTools({
    scheduling: system,
    tenant: TENANT,
    sessionId: 'ses_test',
    timeZone: 'Asia/Riyadh',
    log,
    verificationPolicy: 'dev-identifier-dob',
    now: () => NOW,
    ...options?.tools,
  });
  let userTurn = 0;
  const outputs: unknown[] = [];
  /** What the system spoke in each turn (read-backs, results); played to the caller in full when the turn ends. */
  const spoken = new Map<string, string[]>();
  /**
   * A new caller turn; returns a function that plays one model tool call within that turn. The previous
   * turn ends first, as in a voice session: the caller heard everything the system spoke in it.
   */
  const turn = (callerUtterance: string, signal: AbortSignal = new AbortController().signal) => {
    if (userTurn > 0) tools.onTurnFinalized(`turn-${userTurn}`, true, (spoken.get(`turn-${userTurn}`) ?? []).join(' '));
    userTurn += 1;
    const ctx: ToolTurnContext = { userTurn, callerUtterance, turnId: `turn-${userTurn}`, signal };
    return async (name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
      const { output, speech } = await tools.execute(name, JSON.stringify(args), ctx);
      if (speech !== undefined) spoken.set(ctx.turnId, [...(spoken.get(ctx.turnId) ?? []), speech]);
      outputs.push(output);
      return output;
    };
  };
  const ctx = { tenant: TENANT, signal: new AbortController().signal };
  return { system, tools, log, turn, outputs, ctx };
}

type Call = ReturnType<ReturnType<typeof setup>['turn']>;

const str = (value: unknown): string => {
  if (typeof value !== 'string') throw new Error(`expected a string, got ${JSON.stringify(value)}`);
  return value;
};
const first = (output: Record<string, unknown>, list: string): Record<string, unknown> => {
  const items = output[list] as Record<string, unknown>[] | undefined;
  if (!items?.[0]) throw new Error(`no ${list} in ${JSON.stringify(output)}`);
  return items[0];
};

async function serviceRef(call: Call, query: string): Promise<string> {
  const out = await call('search_clinic_directory', { query, kind: 'service', service_ref: null });
  return str(first(out, 'results')['ref']);
}

async function verify(call: Call, args: { national_id?: string; phone?: string; birth_date: string }): Promise<string> {
  const out = await call('find_patient', { national_id: args.national_id ?? null, phone: args.phone ?? null, birth_date: args.birth_date });
  expect(out).toMatchObject({ status: 'verified' });
  return str((out['patient'] as Record<string, unknown>)['ref']);
}

async function firstSlot(call: Call, service: string, extra?: Record<string, unknown>): Promise<Record<string, unknown>> {
  const out = await call('search_available_slots', {
    service_ref: service,
    practitioner_ref: null,
    date_from: TODAY,
    date_to: null,
    part_of_day: null,
    for_appointment_ref: null,
    ...extra,
  });
  return first(out, 'slots');
}

describe('AppointmentTools', () => {
  it('exposes the allowed tools with strict schemas and rejects others', async () => {
    const { tools } = setup({ tools: { allowedTools: ['search_clinic_directory', 'search_available_slots'] } });
    expect(tools.definitions().map((d) => d.name)).toEqual(['search_clinic_directory', 'search_available_slots']);
    expect(setup().tools.definitions()).toHaveLength(9);
    const ctx = { userTurn: 1, callerUtterance: '', turnId: 't', signal: new AbortController().signal };
    expect((await tools.execute('propose_booking', '{"patient_ref":"P1","slot_ref":"S1"}', ctx)).output).toMatchObject({ status: 'unknown_tool' });
    expect((await tools.execute('drop_database', '{}', ctx)).output).toMatchObject({ status: 'unknown_tool' });
    expect((await tools.execute('search_clinic_directory', '{"query":"x"}', ctx)).output).toMatchObject({ status: 'invalid_arguments' });
  });

  it('books end to end only after the caller says yes in the next turn, without exposing system IDs', async () => {
    const { turn, outputs, system, ctx } = setup();
    let call = turn('أبي موعد طب أسرة، جوالي ٠٥٠٠٠٠٠١٠٥ ومواليد ١٩٧٨-٠١-٢٥');
    const service = await serviceRef(call, 'طب الأسرة');
    const patient = await verify(call, { phone: '٠٥٠٠٠٠٠١٠٥', birth_date: '1978-01-25' });
    const slot = await firstSlot(call, service);
    const proposal = await call('propose_booking', { patient_ref: patient, slot_ref: slot['ref'] });
    expect(proposal).toMatchObject({ status: 'confirmation_required', action_ref: 'C1', read_back: { patient: 'تركي', doctor: 'فهد العتيبي', time: slot['time'] } });
    // The model tries to confirm on its own, in the same turn: refused.
    expect(await call('confirm_pending_action', { action_ref: 'C1', caller_answer: 'yes' })).toMatchObject({ status: 'caller_confirmation_required' });

    call = turn('إيه احجز لو سمحت');
    const done = await call('confirm_pending_action', { action_ref: 'C1', caller_answer: 'yes' });
    expect(done).toMatchObject({ status: 'done', appointment: { date: slot['date'], time: slot['time'], doctor: 'فهد العتيبي' } });

    const [record] = await system.findPatients(ctx, { phone: '+966500000105' });
    expect((await system.listAppointments(ctx, { patientId: record?.id ?? '' })).length).toBe(1);
    expect(JSON.stringify(outputs)).not.toMatch(/mem-|1000000500|1978-01-25/);
  });

  it('never lets the model supply the confirmation itself', async () => {
    const { turn } = setup();
    const call = turn('...');
    expect(await call('confirm_pending_action', { action_ref: 'C1', caller_said: 'إيه', caller_answer: 'yes' })).toMatchObject({ status: 'invalid_arguments' });
  });

  it('asks again on an unclear reply and executes only on a later clear yes', async () => {
    const { turn } = setup();
    let call = turn('');
    const patient = await verify(call, { national_id: '1000000500', birth_date: '1978-01-25' });
    const slot = await firstSlot(call, await serviceRef(call, 'جلدية'));
    await call('propose_booking', { patient_ref: patient, slot_ref: slot['ref'] });
    call = turn('إيه بس خله الساعة خمس');
    // Even if the model reads it as a yes: the caller's own words carry a condition and a time.
    expect(await call('confirm_pending_action', { action_ref: 'C1', caller_answer: 'yes' })).toMatchObject({ status: 'confirmation_unclear', attempts_left: 1 });
    call = turn('ايوه');
    expect(await call('confirm_pending_action', { action_ref: 'C1', caller_answer: 'yes' })).toMatchObject({ status: 'done' });
  });

  it('books on the natural Saudi answers to "أثبّت الحجز؟", and on wordings only the model understands', async () => {
    for (const [reply, expected] of [
      ['ثبّت الحجز', 'done'],
      ['إيه ثبّت', 'done'],
      ['مافي مشكلة', 'done'], // unknown to the word list, read as a yes by the model, nothing against it
    ] as const) {
      const { turn } = setup();
      let call = turn('');
      const patient = await verify(call, { national_id: '1000000500', birth_date: '1978-01-25' });
      const slot = await firstSlot(call, await serviceRef(call, 'جلدية'));
      await call('propose_booking', { patient_ref: patient, slot_ref: slot['ref'] });
      call = turn(reply);
      expect(await call('confirm_pending_action', { action_ref: 'C1', caller_answer: 'yes' }), reply).toMatchObject({ status: expected });
    }
  });

  it('never executes when the model does not read a yes, and discards on its no', async () => {
    const { turn } = setup();
    let call = turn('');
    const patient = await verify(call, { national_id: '1000000500', birth_date: '1978-01-25' });
    const slot = await firstSlot(call, await serviceRef(call, 'جلدية'));
    await call('propose_booking', { patient_ref: patient, slot_ref: slot['ref'] });
    call = turn('مافي مشكلة');
    expect(await call('confirm_pending_action', { action_ref: 'C1', caller_answer: 'unclear' })).toMatchObject({ status: 'confirmation_unclear' });
    call = turn('أفضّل أأجّله'); // no "no" in the words: the model's reading decides, and discarding writes nothing
    expect(await call('confirm_pending_action', { action_ref: 'C1', caller_answer: 'no' })).toMatchObject({ status: 'declined' });
  });

  it('discards the action on a clear no', async () => {
    const { turn, system, ctx } = setup();
    let call = turn('');
    const patient = await verify(call, { national_id: '1000000500', birth_date: '1978-01-25' });
    const slot = await firstSlot(call, await serviceRef(call, 'أطفال'));
    await call('propose_booking', { patient_ref: patient, slot_ref: slot['ref'] });
    call = turn('لا خلاص');
    expect(await call('confirm_pending_action', { action_ref: 'C1', caller_answer: 'yes' })).toMatchObject({ status: 'declined' });
    const [record] = await system.findPatients(ctx, { nationalId: '1000000500' });
    expect(await system.listAppointments(ctx, { patientId: record?.id ?? '' })).toEqual([]);
  });

  it('relies on the system at execution time when the slot was taken after the proposal', async () => {
    const { turn, system, ctx } = setup();
    let call = turn('');
    const patient = await verify(call, { national_id: '1000000500', birth_date: '1978-01-25' });
    const service = await serviceRef(call, 'طب الأسرة');
    const slot = await firstSlot(call, service);
    await call('propose_booking', { patient_ref: patient, slot_ref: slot['ref'] });

    // Someone else books the same time through another channel.
    const [other] = await system.findPatients(ctx, { nationalId: '1000000100' });
    const { slots } = await system.findAvailability(ctx, {
      serviceId: (await system.searchDirectory(ctx, { text: 'طب الأسرة', kind: 'service', limit: 1 })).entries.map((e) => (e.kind === 'service' ? e.service.id : ''))[0] ?? '',
      from: NOW,
      to: new Date(NOW.getTime() + 7 * 86_400_000),
      limit: 1,
    });
    await system.book(ctx, { patientId: other?.id ?? '', slot: slots[0]!, idempotencyKey: 'other-channel' });

    call = turn('إيه');
    expect(await call('confirm_pending_action', { action_ref: 'C1', caller_answer: 'yes' })).toMatchObject({ status: 'slot_unavailable' });
  });

  it('verifies with the date of birth, answers the same for unknown and wrong, and locks after three failures', async () => {
    const { turn, outputs } = setup();
    const call = turn('');
    const wrongDob = await call('find_patient', { national_id: '1000000100', phone: null, birth_date: '1990-03-15' });
    const unknown = await call('find_patient', { national_id: '1999999990', phone: null, birth_date: '1990-03-14' });
    expect(wrongDob).toMatchObject({ status: 'not_verified', attempts_left: 2 });
    // Unknown number and wrong date of birth answer alike; `checked` only echoes the caller's own input.
    const { checked: _wrongInput, ...wrongDobAnswer } = wrongDob;
    const { checked: _unknownInput, ...unknownAnswer } = unknown;
    expect({ ...unknownAnswer, attempts_left: 2 }).toEqual(wrongDobAnswer);
    expect(await call('find_patient', { national_id: '1000000100', phone: null, birth_date: '1990-03-16' })).toMatchObject({ status: 'locked' });
    expect(await call('find_patient', { national_id: '1000000100', phone: null, birth_date: '1990-03-14' })).toMatchObject({ status: 'locked' });
    expect(
      await call('propose_registration', { full_name: 'س', national_id: '1000000700', phone: '0500000107', birth_date: '1990-01-01', gender: 'male' }),
    ).toMatchObject({ status: 'locked' });
    expect(JSON.stringify(outputs)).not.toContain('عبدالله');
  });

  it('tells the model which patients this call already verified, so it does not ask for identity again', async () => {
    const { tools, turn } = setup();
    expect(tools.contextNote()).toBe('التاريخ والوقت الآن في العيادة: الأحد 2026-10-11، الساعة 08:00 (Asia/Riyadh). مدخلات الأدوات بالتاريخ YYYY-MM-DD والوقت HH:mm.');
    const call = turn('');
    await call('find_patient', { national_id: '1000000100', phone: null, birth_date: '1990-03-15' }); // a failed attempt verifies no one
    expect(tools.contextNote()).not.toContain('المتحقق منهم');
    const patient = await verify(call, { national_id: '1000000100', birth_date: '1990-03-14' });
    const note = tools.contextNote().split('\n');
    expect(note).toHaveLength(2);
    expect(note[1]).toBe(`المرضى المتحقق منهم في هذي المكالمة: ${patient} (عبدالله). لا تطلب منهم الهوية أو تاريخ الميلاد مرة ثانية، واستخدم مرجع المريض مباشرة.`);
    expect(tools.contextNote()).not.toMatch(/1000000100|1990-03-14/); // refs and first names only
  });

  it('finds the caller by phone however the number was said, and still tells family members apart', async () => {
    for (const phone of ['+966 0500000103', '00966 05 0000 0103', '٠٥٠٠٠٠٠١٠٣', '‎050 000 0103', 'صفر، خمسة، صفر، صفر، صفر، صفر، صفر، واحد، صفر، ثلاثة']) {
      const { turn } = setup();
      const call = turn('');
      expect(await call('find_patient', { national_id: null, phone, birth_date: '2020-05-09' }), phone).toMatchObject({ status: 'verified', patient: { first_name: 'جود' } });
      expect(await call('find_patient', { national_id: null, phone, birth_date: '1992-11-20' }), phone).toMatchObject({ status: 'verified', patient: { first_name: 'هيا' } });
    }
    const { turn } = setup();
    const call = turn('');
    for (const phone of ['0112345678', 'جوالي صفر خمسة', '05000001034']) {
      expect(await call('find_patient', { national_id: null, phone, birth_date: '2020-05-09' }), phone).toMatchObject({ status: 'invalid_phone' });
    }
  });

  it('tells the caller what was received when a number is unusable or not verified (STT dropped a zero, observed live)', async () => {
    const { turn } = setup();
    const call = turn('');
    // "050000105": nine digits — one of the five zeros was lost in transcription.
    expect(await call('find_patient', { national_id: null, phone: '050000105', birth_date: '1978-01-25' })).toMatchObject({
      status: 'invalid_phone',
      heard: 'صفر خمسة صفر صفر صفر صفر واحد صفر خمسة',
      digits_heard: 9,
    });
    expect(await call('find_patient', { national_id: null, phone: 'صفر خمسة صفر صفر', birth_date: '1978-01-25' })).toMatchObject({ status: 'invalid_phone', digits_heard: 4 });
    expect(await call('find_patient', { national_id: '100000050', phone: null, birth_date: '1978-01-25' })).toMatchObject({ status: 'invalid_national_id', digits_heard: 9 });
    // A well-formed but wrong number: what was checked is read back (the caller's own input only).
    expect(await call('find_patient', { national_id: null, phone: '0500000106', birth_date: '1978-01-25' })).toMatchObject({
      status: 'not_verified',
      checked: { phone: 'صفر خمسة صفر صفر صفر صفر صفر واحد صفر ستّة', birth_date: 'خمس وعشرين يناير ألف وتسعمية وثمان وسبعين' },
    });
    expect(await call('find_patient', { national_id: null, phone: '0500000105', birth_date: '1978-01-25' })).toMatchObject({ status: 'verified', patient: { first_name: 'تركي' } });
  });

  it('tells family members on one phone apart by date of birth', async () => {
    const { turn } = setup();
    const call = turn('');
    const out = await call('find_patient', { national_id: null, phone: '0500000103', birth_date: '2020-05-09' });
    expect(out).toMatchObject({ status: 'verified', patient: { first_name: 'جود' } });
  });

  it('refuses invented or unverified refs', async () => {
    const { turn } = setup();
    const call = turn('');
    expect(await call('propose_booking', { patient_ref: 'P9', slot_ref: 'S1' })).toMatchObject({ status: 'unknown_ref' });
    expect(await call('list_patient_appointments', { patient_ref: 'P1' })).toMatchObject({ status: 'unknown_ref' });
    // A ref from another session means nothing here.
    const other = setup();
    const otherCall = other.turn('');
    const slot = await firstSlot(otherCall, await serviceRef(otherCall, 'جلدية'));
    const patient = await verify(call, { national_id: '1000000500', birth_date: '1978-01-25' });
    expect(slot['ref']).toBe('S1');
    expect(await call('propose_booking', { patient_ref: patient, slot_ref: 'S1' })).toMatchObject({ status: 'unknown_ref' });
  });

  it('reschedules within the same service and refuses a change of service', async () => {
    const { turn } = setup();
    let call = turn('');
    const patient = await verify(call, { national_id: '1000000100', birth_date: '1990-03-14' });
    const list = await call('list_patient_appointments', { patient_ref: patient });
    const appointment = first(list, 'appointments');
    const family = await serviceRef(call, 'طب الأسرة');
    const target = await firstSlot(call, family, { for_appointment_ref: appointment['ref'], part_of_day: 'evening' });
    expect(str(target['time']) >= '17:00').toBe(true);

    const pediatrics = await serviceRef(call, 'أطفال');
    const otherService = await firstSlot(call, pediatrics);
    expect(await call('propose_reschedule', { appointment_ref: appointment['ref'], new_slot_ref: otherService['ref'] })).toMatchObject({
      status: 'service_change_not_allowed',
    });

    const proposal = await call('propose_reschedule', { appointment_ref: appointment['ref'], new_slot_ref: target['ref'] });
    expect(proposal).toMatchObject({ status: 'confirmation_required', read_back: { from: { time: appointment['time'] }, to: { time: target['time'] } } });
    call = turn('إيه انقله');
    expect(await call('confirm_pending_action', { action_ref: proposal['action_ref'], caller_answer: 'yes' })).toMatchObject({
      status: 'done',
      appointment: { ref: appointment['ref'], time: target['time'], date: target['date'] },
    });
  });

  it('cancels after confirmation, and refuses a stale action when the appointment changed meanwhile', async () => {
    const { turn, system, ctx } = setup();
    let call = turn('');
    const patient = await verify(call, { national_id: '1000000200', birth_date: '1985-07-02' });
    const list = await call('list_patient_appointments', { patient_ref: patient });
    const [a, b] = list['appointments'] as Record<string, unknown>[];
    if (!a || !b) throw new Error('patient-two-upcoming has two appointments');

    await call('propose_cancellation', { appointment_ref: a['ref'], reason: null });
    call = turn('إيه ألغيه');
    expect(await call('confirm_pending_action', { action_ref: 'C1', caller_answer: 'yes' })).toMatchObject({ status: 'done', cancelled: { ref: a['ref'] } });

    call = turn('والثاني بعد ألغيه');
    await call('propose_cancellation', { appointment_ref: b['ref'], reason: 'سفر' });
    // Staff move the appointment through another channel before the caller answers.
    const [record] = await system.findPatients(ctx, { nationalId: '1000000200' });
    const [current] = await system.listAppointments(ctx, { patientId: record?.id ?? '' });
    if (!current) throw new Error('appointment missing');
    const { slots } = await system.findAvailability(ctx, {
      serviceId: current.serviceId,
      practitionerIds: [current.practitionerId],
      from: NOW,
      to: new Date(NOW.getTime() + 7 * 86_400_000),
      limit: 1,
      ignoreAppointmentId: current.id,
    });
    await system.reschedule(ctx, { appointmentId: current.id, newSlot: slots[0]!, idempotencyKey: 'staff' });
    call = turn('إيه');
    expect(await call('confirm_pending_action', { action_ref: 'C2', caller_answer: 'yes' })).toMatchObject({ status: 'stale_action' });
  });

  it('registers a new patient after confirmation, who can then book', async () => {
    const { turn } = setup();
    let call = turn('');
    expect(await call('find_patient', { national_id: '١٠٠٠٠٠٠٧٠٠', phone: null, birth_date: '1999-09-09' })).toMatchObject({ status: 'not_verified' });
    const proposal = await call('propose_registration', {
      full_name: 'ريان سعيد الشمري',
      national_id: '١٠٠٠ ٠٠٠ ٧٠٠',
      phone: '٠٥٠٠٠٠٠١٠٧',
      birth_date: '1999-09-09',
      gender: 'male',
    });
    expect(proposal).toMatchObject({ status: 'confirmation_required', read_back: { national_id: '1000000700', phone: '0500000107', birth_date: '1999-09-09' } });
    call = turn('ايوه سجلني');
    const done = await call('confirm_pending_action', { action_ref: proposal['action_ref'], caller_answer: 'yes' });
    expect(done).toMatchObject({ status: 'done', patient: { first_name: 'ريان' } });
    const patient = str((done['patient'] as Record<string, unknown>)['ref']);
    const slot = await firstSlot(call, await serviceRef(call, 'جلدية'));
    expect(await call('propose_booking', { patient_ref: patient, slot_ref: slot['ref'] })).toMatchObject({ status: 'confirmation_required' });
  });

  it('asks for details the caller has not given instead of taking a guess, without using up verification attempts', async () => {
    const { turn, system, ctx } = setup();
    const call = turn('أبي أعرف مواعيدي');
    for (let i = 0; i < 3; i += 1) {
      expect(await call('find_patient', { national_id: '1000000500', phone: null, birth_date: null })).toMatchObject({ status: 'missing_information', missing: ['birth_date'] });
    }
    expect(await call('find_patient', { national_id: null, phone: null, birth_date: null })).toMatchObject({ status: 'missing_information', missing: ['national_id_or_phone', 'birth_date'] });
    await verify(call, { national_id: '1000000500', birth_date: '1978-01-25' }); // not locked: nothing was checked

    // Observed live: a birth date the caller never said was filled in as 1900-01-01.
    const partial = { full_name: 'ريان سعيد الشمري', national_id: '1000000700', phone: null, birth_date: null, gender: null };
    expect(await call('propose_registration', partial)).toMatchObject({ status: 'missing_information', missing: ['phone', 'birth_date'] });
    expect(await system.findPatients(ctx, { nationalId: '1000000700' })).toEqual([]);
  });

  it('asks for the Gregorian date when a date of birth has a Hijri year (not supported yet), and keeps other bad dates generic', async () => {
    const { turn } = setup();
    const call = turn('مواليد ألف وأربعمية وثلاثة وثلاثين');
    expect(await call('find_patient', { national_id: '1000000500', phone: null, birth_date: '1433-01-01' })).toMatchObject({ status: 'hijri_birth_date' });
    const registration = { full_name: 'ريان سعيد الشمري', national_id: '1000000700', phone: '0500000107', gender: null };
    expect(await call('propose_registration', { ...registration, birth_date: '1418-05-10' })).toMatchObject({ status: 'hijri_birth_date' });
    expect(await call('find_patient', { national_id: '1000000500', phone: null, birth_date: '2999-01-01' })).toMatchObject({ status: 'invalid_birth_date' });
    await verify(call, { national_id: '1000000500', birth_date: '1978-01-25' }); // none of these counted as a failed attempt
  });

  it('registers without a gender the caller did not give, and announces the result from the stored record', async () => {
    const { turn, system, ctx } = setup();
    let call = turn('أبي أفتح ملف');
    const proposal = await call('propose_registration', { full_name: 'ريان سعيد الشمري', national_id: '1000000700', phone: '0500000107', birth_date: '1999-09-09', gender: null });
    expect(proposal).toMatchObject({ status: 'confirmation_required', read_back: { gender: 'unknown' } });
    call = turn('إيه');
    const done = await call('confirm_pending_action', { action_ref: proposal['action_ref'], caller_answer: 'yes' });
    expect(done).toMatchObject({ status: 'done', spoken: 'تم فتح الملف باسم ريان سعيد الشمري. تبي أخدمك بشي ثاني؟' });
    const [record] = await system.findPatients(ctx, { nationalId: '1000000700' });
    expect(record?.gender).toBe('unknown'); // never inferred from the name
  });

  it('reports an existing national ID at registration as already_exists', async () => {
    const { turn } = setup();
    let call = turn('');
    await call('propose_registration', { full_name: 'اسم', national_id: '1000000100', phone: '0500000199', birth_date: '1990-01-01', gender: 'male' });
    call = turn('إيه');
    expect(await call('confirm_pending_action', { action_ref: 'C1', caller_answer: 'yes' })).toMatchObject({ status: 'already_exists' });
  });

  it('completes a confirmed write even when the caller interrupts the turn', async () => {
    const { turn, system, ctx } = setup({ latencyMs: 40 });
    let call = turn('');
    const patient = await verify(call, { national_id: '1000000500', birth_date: '1978-01-25' });
    const slot = await firstSlot(call, await serviceRef(call, 'جلدية'));
    await call('propose_booking', { patient_ref: patient, slot_ref: slot['ref'] });

    const controller = new AbortController();
    call = turn('إيه', controller.signal);
    const pending = call('confirm_pending_action', { action_ref: 'C1', caller_answer: 'yes' });
    setTimeout(() => controller.abort(new CancelledError('barge_in')), 10);
    expect(await pending).toMatchObject({ status: 'done' });
    const [record] = await system.findPatients(ctx, { nationalId: '1000000500' });
    expect(await system.listAppointments(ctx, { patientId: record?.id ?? '' })).toHaveLength(1);
  });

  it('cancels reads when the turn is abandoned', async () => {
    const { turn } = setup({ latencyMs: 1_000 });
    const controller = new AbortController();
    const call = turn('', controller.signal);
    const pending = call('search_clinic_directory', { query: 'جلدية', kind: 'any', service_ref: null });
    setTimeout(() => controller.abort(new CancelledError('user_continued')), 10);
    await expect(pending).rejects.toBeInstanceOf(CancelledError);
  });

  it('reconciles an ambiguous write by reading: applied → done, not applied → not_applied', async () => {
    const { turn, system } = setup();
    let call = turn('');
    const patient = await verify(call, { national_id: '1000000500', birth_date: '1978-01-25' });
    const service = await serviceRef(call, 'طب الأسرة');
    const slot = await firstSlot(call, service);
    await call('propose_booking', { patient_ref: patient, slot_ref: slot['ref'] });
    system.failNext('book', new ProviderError('memory', 'timeout', 'reply lost'), { afterCommit: true });
    call = turn('إيه');
    expect(await call('confirm_pending_action', { action_ref: 'C1', caller_answer: 'yes' })).toMatchObject({ status: 'done' });

    call = turn('أبي موعد ثاني'); // the spoken result ended the previous turn
    const next = await call('search_available_slots', { service_ref: service, practitioner_ref: null, date_from: TODAY, date_to: null, part_of_day: null, for_appointment_ref: null });
    await call('propose_booking', { patient_ref: patient, slot_ref: first(next, 'slots')['ref'] });
    system.failNext('book', new ProviderError('memory', 'unavailable', 'gateway error'));
    call = turn('إيه');
    expect(await call('confirm_pending_action', { action_ref: 'C2', caller_answer: 'yes' })).toMatchObject({ status: 'not_applied' });
  });

  it('keeps an unresolved outcome blocking new writes for that patient, and resolves it later', async () => {
    const { turn, system, tools } = setup();
    let call = turn('');
    const patient = await verify(call, { national_id: '1000000500', birth_date: '1978-01-25' });
    const service = await serviceRef(call, 'طب الأسرة');
    const slot = await firstSlot(call, service);
    await call('propose_booking', { patient_ref: patient, slot_ref: slot['ref'] });
    system.failNext('book', new ProviderError('memory', 'unavailable', 'gateway error'), { afterCommit: true });
    system.failNext('listAppointments', new ProviderError('memory', 'unavailable', 'still down'));
    system.failNext('listAppointments', new ProviderError('memory', 'unavailable', 'still down'));
    call = turn('إيه');
    expect(await call('confirm_pending_action', { action_ref: 'C1', caller_answer: 'yes' })).toMatchObject({ status: 'outcome_unknown' });

    // Second (last) reconciliation attempt also fails: the patient stays blocked for this call.
    const other = await firstSlot(call, service);
    expect(await call('propose_booking', { patient_ref: patient, slot_ref: other['ref'] })).toMatchObject({ status: 'previous_action_unresolved' });
    expect(await tools.reconcileUnresolved()).toEqual([]);

    // A different setup where the later attempt succeeds: resolved and unblocked.
    const second = setup();
    let c2 = second.turn('');
    const p2 = await verify(c2, { national_id: '1000000500', birth_date: '1978-01-25' });
    const s2 = await serviceRef(c2, 'طب الأسرة');
    await c2('propose_booking', { patient_ref: p2, slot_ref: (await firstSlot(c2, s2))['ref'] });
    second.system.failNext('book', new ProviderError('memory', 'unavailable', 'x'), { afterCommit: true });
    second.system.failNext('listAppointments', new ProviderError('memory', 'unavailable', 'y'));
    c2 = second.turn('إيه');
    expect(await c2('confirm_pending_action', { action_ref: 'C1', caller_answer: 'yes' })).toMatchObject({ status: 'outcome_unknown' });
    expect(await second.tools.reconcileUnresolved()).toEqual([{ action_ref: 'C1', kind: 'booking', applied: true }]);
    const again = await firstSlot(c2, s2);
    expect(await c2('propose_booking', { patient_ref: p2, slot_ref: again['ref'] })).toMatchObject({ status: 'confirmation_required' });
  });

  it('drops a proposal the caller never heard', async () => {
    const { turn, tools } = setup();
    let call = turn('');
    const patient = await verify(call, { national_id: '1000000500', birth_date: '1978-01-25' });
    const slot = await firstSlot(call, await serviceRef(call, 'جلدية'));
    await call('propose_booking', { patient_ref: patient, slot_ref: slot['ref'] });
    tools.onTurnFinalized('turn-1', false);
    call = turn('إيه');
    expect(await call('confirm_pending_action', { action_ref: 'C1', caller_answer: 'yes' })).toMatchObject({ status: 'expired' });
  });

  it('filters by part of day and clamps the search window', async () => {
    const { turn } = setup();
    const call = turn('');
    const pediatrics = await serviceRef(call, 'أطفال');
    const base = { service_ref: pediatrics, practitioner_ref: null, for_appointment_ref: null };
    const morning = await call('search_available_slots', { ...base, date_from: TODAY, date_to: null, part_of_day: 'morning' });
    const evening = await call('search_available_slots', { ...base, date_from: TODAY, date_to: null, part_of_day: 'evening' });
    for (const s of morning['slots'] as { time: string }[]) expect(s.time < '12:00').toBe(true);
    for (const s of evening['slots'] as { time: string }[]) expect(s.time >= '17:00').toBe(true);
    expect((evening['slots'] as unknown[]).length).toBeGreaterThan(0);
    const clamped = await call('search_available_slots', { ...base, date_from: '2026-01-01', date_to: '2026-12-31', part_of_day: null });
    expect(clamped['window']).toEqual({ from: TODAY, to: '2026-10-24' });
  });

  it('logs decisions without personal data', async () => {
    const { turn, log } = setup();
    let call = turn('');
    const patient = await verify(call, { national_id: '1000000100', birth_date: '1990-03-14' });
    const slot = await firstSlot(call, await serviceRef(call, 'طب الأسرة'));
    await call('propose_booking', { patient_ref: patient, slot_ref: slot['ref'] });
    call = turn('إيه');
    await call('confirm_pending_action', { action_ref: 'C1', caller_answer: 'yes' });
    const text = JSON.stringify(log.lines);
    expect(text).not.toMatch(/1000000100|1990-03-14|966500000101|عبدالله|الحربي/);
    const audit = log.lines.filter((l) => l.event === 'tool.audit').map((l) => l.fields['phase']);
    expect(audit).toEqual(['proposed', 'confirmed', 'executed']);
    expect(log.lines.find((l) => l.event === 'patient.verification')?.fields).toMatchObject({ policy: 'dev-identifier-dob', outcome: 'verified' });
  });
});
