import { randomInt } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { FakeLanguageModel, type FakeRound } from '../../src/adapters/fakes/fake-llm.js';
import { type AgentToolbox, AgentTurn } from '../../src/agent/agent-turn.js';
import { Conversation } from '../../src/agent/conversation.js';
import { AppointmentTools } from '../../src/agent/tools/appointment-tools.js';
import { loadAgentProfile } from '../../src/app/agent-profile.js';
import { createScheduling } from '../../src/app/container.js';
import { loadSchedulingDataset } from '../../src/app/scheduling-dataset.js';
import { loadSettings } from '../../src/config/settings.js';
import { nationalIdChecksumValid } from '../../src/core/identifiers.js';
import { silentLogger } from '../../src/core/logger.js';
import { type LocalDate, addDays, instantToZoned, zonedToInstant } from '../../src/core/zoned-time.js';
import { type LlmRequest, isChatMessage } from '../../src/ports/language-model.js';
import type { SchedulingContext, SchedulingSystem } from '../../src/ports/scheduling.js';

/**
 * Plan step 9 (§8): the scheduling system is replaceable by configuration alone. The same agent scenarios
 * run unchanged for every scheduling provider: a scripted model drives the real AgentTurn and
 * AppointmentTools, and the scheduling system is built by the composition root (`createScheduling`) from
 * settings — between providers only `MUJEEB_SCHEDULING_PROVIDER` (and its credentials) differs.
 *
 * Every scenario also checks that the model never received an ID or slot token of the scheduling system:
 * each one the system returned is recorded and searched for in every model request and tool output.
 *
 * Runs on the in-memory system on every `npm test`, and on the Medplum sandbox in the gated live suite.
 * Writes only for patients the scenarios register themselves (phone `+966500000199`).
 */

export interface AgentSchedulingFixture {
  /** Environment for `loadSettings`. */
  env: Record<string, string | undefined>;
  /** Test-only decoration of the system the composition root built (the live write guard). */
  wrap?: (system: SchedulingSystem) => SchedulingSystem;
}

/** Phone of the patients these scenarios register (outside the dataset's numbers). */
const SCENARIO_PATIENT_PHONE = '0500000199';
/**
 * Days ahead the write scenarios search from. Other live suites book the first free slots of the first
 * week (anchor + 1…7); in a parallel live run they took the same dermatology slot (observed 2026-10-18).
 */
const BOOKING_DAYS_AHEAD = 12;
const CONFLICT_DAYS_AHEAD = 16;
/** Keys under which a scheduling system returns its own identifiers. */
const ID_KEYS = new Set(['id', 'serviceId', 'practitionerId', 'patientId', 'appointmentId', 'token']);
const SYSTEM_ID_PATTERNS = [
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
  /\b(?:Patient|Appointment|Practitioner|PractitionerRole|HealthcareService|Schedule|Slot)\/[A-Za-z0-9-]+/,
  /\bmem-[a-z]+-\d+/,
];

/** A fresh, well-formed national ID that fails the checksum (never a real person). */
function syntheticNationalId(): string {
  const body = `1${String(randomInt(100_000_000)).padStart(8, '0')}`;
  for (let check = 0; check < 10; check += 1) {
    const id = `${body}${check}`;
    if (!nationalIdChecksumValid(id)) return id;
  }
  throw new Error('unreachable: at most one check digit is valid');
}

/** The same system, recording every identifier it returns to its caller (the tools). */
function recordingIds(system: SchedulingSystem, ids: Set<string>): SchedulingSystem {
  const collect = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const v of value) collect(v);
    } else if (value !== null && typeof value === 'object' && !(value instanceof Date)) {
      for (const [key, v] of Object.entries(value)) {
        if (ID_KEYS.has(key) && typeof v === 'string' && v !== '') ids.add(v);
        else collect(v);
      }
    }
  };
  return new Proxy(system, {
    get(target, prop, receiver) {
      const value: unknown = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;
      return async (...args: unknown[]): Promise<unknown> => {
        const result: unknown = await (value as (...a: unknown[]) => Promise<unknown>).apply(target, args);
        collect(result);
        return result;
      };
    },
  });
}

/** Outputs of the tool calls made so far in the current user turn, oldest first. */
function turnOutputs(request: LlmRequest): Record<string, unknown>[] {
  const outputs: Record<string, unknown>[] = [];
  for (let i = request.messages.length - 1; i >= 0; i -= 1) {
    const m = request.messages[i];
    if (!m) continue;
    if (isChatMessage(m)) {
      if (m.role === 'user') break;
      continue;
    }
    outputs.unshift(...m.results.map((r) => JSON.parse(r.output) as Record<string, unknown>));
  }
  return outputs;
}

type Step = (outputs: readonly Record<string, unknown>[]) => FakeRound;

interface ToolRecord {
  turnId: string;
  name: string;
  outcome: string;
  output: Record<string, unknown>;
}

interface TurnResult {
  user: string;
  reply: string;
  tools: ToolRecord[];
}

const call = (name: string, args: Record<string, unknown>): FakeRound => ({ toolCalls: [{ name, arguments: args }] });
const str = (value: unknown): string => {
  if (typeof value !== 'string') throw new Error(`expected a string, got ${JSON.stringify(value)}`);
  return value;
};
const list = (output: Record<string, unknown> | undefined, key: string): Record<string, unknown>[] => {
  const items = output?.[key];
  if (!Array.isArray(items) || items.length === 0) throw new Error(`no ${key} in ${JSON.stringify(output)}`);
  return items as Record<string, unknown>[];
};
const refOf = (output: Record<string, unknown> | undefined, key: 'patient' | 'appointment'): string => str((output?.[key] as Record<string, unknown> | undefined)?.['ref']);
const outcomes = (t: TurnResult): [string, string][] => t.tools.map((c) => [c.name, c.outcome]);
const output = (t: TurnResult, name: string): Record<string, unknown> => {
  const found = [...t.tools].reverse().find((c) => c.name === name);
  if (!found) throw new Error(`no ${name} call in turn "${t.user}"`);
  return found.output;
};
const slotsQuery = (serviceRef: string, dateFrom: LocalDate, forAppointmentRef: string | null = null) => ({
  service_ref: serviceRef,
  practitioner_ref: null,
  date_from: dateFrom,
  date_to: null,
  part_of_day: null,
  for_appointment_ref: forAppointmentRef,
});

/** One call, wired like a dev-server session, with a scripted model. */
async function startCall(fixture: AgentSchedulingFixture) {
  const settings = loadSettings({ ...fixture.env, MUJEEB_STT_PROVIDER: 'fake', MUJEEB_LLM_PROVIDER: 'fake', MUJEEB_TTS_PROVIDER: 'fake' });
  const profile = await loadAgentProfile(settings.agentProfilePath);
  const toolsProfile = profile.appointmentTools;
  if (!toolsProfile || profile.timezone === undefined) throw new Error('agent profile without appointment tools');
  const timeZone = profile.timezone;
  const built = await createScheduling(settings, profile.tenantId);
  if (!built) throw new Error('MUJEEB_SCHEDULING_PROVIDER built no scheduling system');
  expect(built.name).toBe(settings.scheduling.provider); // the composition root built the configured adapter

  const systemIds = new Set<string>();
  const decorated = fixture.wrap ? fixture.wrap(built) : built;
  const system = recordingIds(decorated, systemIds);
  const tenant = { tenantId: profile.tenantId, agentId: profile.agentId };
  const ctx = (): SchedulingContext => ({ tenant, signal: AbortSignal.timeout(30_000), correlationId: 'agent-scenarios' });

  const tools = new AppointmentTools({
    scheduling: system,
    tenant,
    sessionId: `ses_scenario_${Date.now()}`,
    timeZone,
    log: silentLogger,
    verificationPolicy: toolsProfile.patientVerification,
    ...(toolsProfile.allowedTools ? { allowedTools: toolsProfile.allowedTools } : {}),
    pendingActionTtlMs: toolsProfile.pendingActionTtlSec * 1000,
    maxReconfirmations: toolsProfile.maxReconfirmations,
    readTimeoutMs: settings.scheduling.readTimeoutMs,
    writeTimeoutMs: settings.scheduling.writeTimeoutMs,
  });
  const calls: ToolRecord[] = [];
  const toolbox: AgentToolbox = {
    definitions: () => tools.definitions(),
    execute: async (name, rawArguments, turn) => {
      const result = await tools.execute(name, rawArguments, turn);
      calls.push({ turnId: turn.turnId, name, outcome: result.outcome, output: result.output });
      return result;
    },
    mutates: (name) => tools.mutates(name),
    contextNote: () => tools.contextNote(),
    onTurnFinalized: (turnId, heardAnything, heardText) => tools.onTurnFinalized(turnId, heardAnything, heardText),
    reconcileUnresolved: () => tools.reconcileUnresolved(),
    drain: (timeoutMs) => tools.drain(timeoutMs),
  };

  let steps: readonly Step[] = [];
  const llm = new FakeLanguageModel({ firstTokenDelayMs: 0, tokenDelayMs: 0, script: (request, round) => steps[round]?.(turnOutputs(request)) ?? { text: 'تمام.' } });
  const conversation = new Conversation({ instructions: `${profile.instructions}\n\n${toolsProfile.instructions}`, maxTurns: profile.historyMaxTurns });
  if (profile.greeting) conversation.addAssistant(profile.greeting);
  const transcript: TurnResult[] = [];

  /** One caller turn: the model plays `turnSteps` (one tool round each), then answers in text. */
  const say = async (user: string, turnSteps: readonly Step[] = []): Promise<TurnResult> => {
    steps = turnSteps;
    const userTurn = transcript.length + 1;
    const turnId = `turn-${userTurn}`;
    const agent = new AgentTurn({
      llm,
      conversation,
      tools: toolbox,
      userText: user,
      userTurn,
      turnId,
      signal: AbortSignal.timeout(60_000),
      maxToolRounds: toolsProfile.maxToolRounds,
      firstEventTimeoutMs: settings.llm.firstTokenTimeoutMs,
      mutationGraceMs: 0,
      ...(toolsProfile.waitPhrase !== undefined ? { waitPhrase: toolsProfile.waitPhrase } : {}),
    });
    let reply = '';
    for await (const out of agent.output) reply += out.type === 'text' ? out.text : ' ';
    await agent.done;
    conversation.commitTurn({ user, exchanges: agent.exchanges, assistant: reply });
    toolbox.onTurnFinalized(turnId, true, reply); // without audio, the caller heard the whole reply
    const result: TurnResult = { user, reply, tools: calls.filter((c) => c.turnId === turnId) };
    transcript.push(result);
    return result;
  };

  /** Everything the model received (requests, with instructions, history and tool outputs) or the caller heard. */
  const expectNoSystemIdsReachedTheModel = (): void => {
    const seen = JSON.stringify({ requests: llm.calls, outputs: calls.map((c) => c.output), replies: transcript.map((t) => t.reply) });
    expect(systemIds.size).toBeGreaterThan(0);
    expect([...systemIds].filter((id) => seen.includes(id))).toEqual([]);
    for (const pattern of SYSTEM_ID_PATTERNS) expect(seen).not.toMatch(pattern);
  };

  const dataset = await loadSchedulingDataset(settings.scheduling.datasetPath);
  const today = instantToZoned(new Date(), timeZone).date;
  return { say, system, ctx, dataset, timeZone, today, expectNoSystemIdsReachedTheModel };
}

export function describeAgentSchedulingScenarios(label: string, createFixture: () => AgentSchedulingFixture | Promise<AgentSchedulingFixture>): void {
  describe(`agent scenarios on a swappable scheduling system: ${label}`, () => {
    const start = async () => startCall(await createFixture());

    it('verifies seeded patients and reads their appointments and the directory', async () => {
      const c = await start();
      const patient = (key: string) => {
        const p = c.dataset.patients.find((x) => x.key === key);
        if (!p) throw new Error(`dataset patient ${key} missing`);
        return p;
      };
      const one = patient('patient-one-upcoming');
      const child = patient('patient-child');

      const mine = await c.say('السلام عليكم، أبي أعرف مواعيدي', [
        () => call('find_patient', { national_id: one.nationalId, phone: null, birth_date: '1990-01-01' }),
        () => call('find_patient', { national_id: one.nationalId, phone: null, birth_date: one.birthDate }),
        (out) => call('list_patient_appointments', { patient_ref: refOf(out[1], 'patient') }),
      ]);
      expect(outcomes(mine)).toEqual([
        ['find_patient', 'not_verified'],
        ['find_patient', 'verified'],
        ['list_patient_appointments', 'ok'],
      ]);
      expect(list(output(mine, 'list_patient_appointments'), 'appointments')).toMatchObject([{ ref: 'A1', doctor: 'فهد العتيبي', service: 'طب الأسرة', time: '17:00' }]);

      // A family phone in local format, told apart by the child's date of birth.
      const daughter = await c.say('وموعد بنتي؟', [
        () => call('find_patient', { national_id: null, phone: `0${child.phone.slice(4)}`, birth_date: child.birthDate }),
        (out) => call('list_patient_appointments', { patient_ref: refOf(out[0], 'patient') }),
      ]);
      expect(output(daughter, 'find_patient')).toMatchObject({ status: 'verified', patient: { first_name: child.firstName } });
      expect(list(output(daughter, 'list_patient_appointments'), 'appointments')).toMatchObject([{ doctor: 'ريم القحطاني', service: 'طب الأطفال', time: '16:40' }]);

      const directory = await c.say('عندكم دكتورة ريم؟', [() => call('search_clinic_directory', { query: 'دكتورة ريم', kind: 'practitioner', service_ref: null })]);
      expect(list(output(directory, 'search_clinic_directory'), 'results')[0]).toMatchObject({ kind: 'practitioner', name: 'ريم القحطاني', gender: 'female' });
      c.expectNoSystemIdsReachedTheModel();
    });

    it('registers, books, reschedules and cancels, each only after the caller says yes in the next turn', async () => {
      const c = await start();
      const nationalId = syntheticNationalId();
      const dateFrom = addDays(c.today, BOOKING_DAYS_AHEAD);

      const proposedRegistration = await c.say('أبي أفتح ملف جديد', [
        () => call('propose_registration', { full_name: 'مريض اختبار السيناريوهات', national_id: nationalId, phone: SCENARIO_PATIENT_PHONE, birth_date: '1991-02-03', gender: 'female' }),
      ]);
      expect(outcomes(proposedRegistration)).toEqual([['propose_registration', 'confirmation_required']]);
      expect(await c.system.findPatients(c.ctx(), { nationalId })).toEqual([]); // nothing written before the yes
      const registrationRef = str(output(proposedRegistration, 'propose_registration')['action_ref']);
      const registered = await c.say('إيه', [() => call('confirm_pending_action', { action_ref: registrationRef, caller_answer: 'yes' })]);
      expect(output(registered, 'confirm_pending_action')).toMatchObject({ status: 'done', patient: { first_name: 'مريض' } });
      const patientRef = refOf(output(registered, 'confirm_pending_action'), 'patient');
      const [record] = await c.system.findPatients(c.ctx(), { nationalId });
      if (!record) throw new Error('registered patient not found in the scheduling system');
      expect(record).toMatchObject({ birthDate: '1991-02-03', phone: '+966500000199', gender: 'female' });

      // Booking.
      let serviceRef = '';
      let offered: Record<string, unknown> = {};
      const proposedBooking = await c.say('أبي موعد أطفال', [
        () => call('search_clinic_directory', { query: 'أطفال', kind: 'service', service_ref: null }),
        (out) => {
          serviceRef = str(list(out[0], 'results')[0]?.['ref']);
          return call('search_available_slots', slotsQuery(serviceRef, dateFrom));
        },
        (out) => {
          offered = list(out[1], 'slots')[0] ?? {};
          return call('propose_booking', { patient_ref: patientRef, slot_ref: offered['ref'] });
        },
      ]);
      expect(output(proposedBooking, 'propose_booking')).toMatchObject({ status: 'confirmation_required', read_back: { date: offered['date'], time: offered['time'], doctor: offered['doctor'] } });
      expect(await c.system.listAppointments(c.ctx(), { patientId: record.id })).toEqual([]);
      const booked = await c.say('ثبّت الحجز', [() => call('confirm_pending_action', { action_ref: str(output(proposedBooking, 'propose_booking')['action_ref']), caller_answer: 'yes' })]);
      expect(output(booked, 'confirm_pending_action')).toMatchObject({ status: 'done', appointment: { date: offered['date'], time: offered['time'] } });
      const appointmentRef = refOf(output(booked, 'confirm_pending_action'), 'appointment');
      const [original] = await c.system.listAppointments(c.ctx(), { patientId: record.id });
      if (!original) throw new Error('booking not in the scheduling system');
      expect(instantToZoned(original.start, c.timeZone)).toMatchObject({ date: offered['date'], time: offered['time'] });

      // Rescheduling to another time of the same service.
      let target: Record<string, unknown> = {};
      const proposedMove = await c.say('أبي أغيّر الموعد', [
        () => call('search_available_slots', slotsQuery(serviceRef, dateFrom, appointmentRef)),
        (out) => {
          target = list(out[0], 'slots').find((s) => s['date'] !== offered['date'] || s['time'] !== offered['time']) ?? {};
          return call('propose_reschedule', { appointment_ref: appointmentRef, new_slot_ref: target['ref'] });
        },
      ]);
      expect(output(proposedMove, 'propose_reschedule')).toMatchObject({ status: 'confirmation_required', read_back: { to: { date: target['date'], time: target['time'] } } });
      const moved = await c.say('إيه أكد', [() => call('confirm_pending_action', { action_ref: str(output(proposedMove, 'propose_reschedule')['action_ref']), caller_answer: 'yes' })]);
      expect(output(moved, 'confirm_pending_action')).toMatchObject({ status: 'done', appointment: { date: target['date'], time: target['time'] } });
      const afterMove = await c.system.listAppointments(c.ctx(), { patientId: record.id });
      expect(afterMove.map((a) => a.id)).toEqual([original.id]); // same appointment, new time
      expect(instantToZoned(afterMove[0]?.start ?? new Date(0), c.timeZone)).toMatchObject({ date: target['date'], time: target['time'] });

      // Cancellation: a no changes nothing; a later yes cancels.
      const proposedCancel = await c.say('أبي ألغي الموعد', [() => call('propose_cancellation', { appointment_ref: appointmentRef, reason: null })]);
      expect(outcomes(proposedCancel)).toEqual([['propose_cancellation', 'confirmation_required']]);
      // The scripted model reads a yes; the server decides from the caller's own words.
      const declined = await c.say('لا خلاص', [() => call('confirm_pending_action', { action_ref: str(output(proposedCancel, 'propose_cancellation')['action_ref']), caller_answer: 'yes' })]);
      expect(outcomes(declined)).toEqual([['confirm_pending_action', 'declined']]);
      expect(await c.system.listAppointments(c.ctx(), { patientId: record.id })).toHaveLength(1);
      const proposedAgain = await c.say('طيب ألغيه', [() => call('propose_cancellation', { appointment_ref: appointmentRef, reason: null })]);
      const cancelled = await c.say('إيه', [() => call('confirm_pending_action', { action_ref: str(output(proposedAgain, 'propose_cancellation')['action_ref']), caller_answer: 'yes' })]);
      expect(output(cancelled, 'confirm_pending_action')).toMatchObject({ status: 'done', cancelled: { ref: appointmentRef } });
      expect(await c.system.listAppointments(c.ctx(), { patientId: record.id })).toEqual([]);
      expect((await c.system.getAppointment(c.ctx(), original.id)).status).toBe('cancelled');
      c.expectNoSystemIdsReachedTheModel();
    });

    it('refuses a slot taken between proposal and confirmation, validated by the system at execution', async () => {
      const c = await start();
      const register = async (label: string) => {
        const nationalId = syntheticNationalId();
        const record = await c.system.registerPatient(c.ctx(), {
          patient: { fullName: `مريض اختبار ${label}`, nationalId, phone: '+966500000199', birthDate: '1991-02-03', gender: 'male' },
          idempotencyKey: `scenario-${nationalId}`,
        });
        return { record, nationalId };
      };
      const caller = await register('السيناريو');
      const rival = await register('منافس السيناريو');

      let offered: Record<string, unknown> = {};
      const proposed = await c.say('أبي موعد جلدية', [
        () => call('find_patient', { national_id: caller.nationalId, phone: null, birth_date: '1991-02-03' }),
        () => call('search_clinic_directory', { query: 'جلدية', kind: 'service', service_ref: null }),
        (out) => call('search_available_slots', slotsQuery(str(list(out[1], 'results')[0]?.['ref']), addDays(c.today, CONFLICT_DAYS_AHEAD))),
        (out) => {
          offered = list(out[2], 'slots')[0] ?? {};
          return call('propose_booking', { patient_ref: refOf(out[0], 'patient'), slot_ref: offered['ref'] });
        },
      ]);
      expect(outcomes(proposed).at(-1)).toEqual(['propose_booking', 'confirmation_required']);

      // Someone else takes that exact time meanwhile.
      const startsAt = zonedToInstant(str(offered['date']), str(offered['time']), c.timeZone);
      const { entries } = await c.system.searchDirectory(c.ctx(), { text: 'الجلدية', kind: 'service', limit: 1 });
      const serviceId = entries[0]?.kind === 'service' ? entries[0].service.id : '';
      const { slots } = await c.system.findAvailability(c.ctx(), { serviceId, from: startsAt, to: new Date(startsAt.getTime() + 60_000), limit: 5 });
      const same = slots.find((s) => s.start.getTime() === startsAt.getTime() && s.practitionerName === offered['doctor']);
      if (!same) throw new Error('offered slot not found again');
      await c.system.book(c.ctx(), { patientId: rival.record.id, slot: same, idempotencyKey: `rival-${rival.nationalId}` });

      const refused = await c.say('إيه', [() => call('confirm_pending_action', { action_ref: str(output(proposed, 'propose_booking')['action_ref']), caller_answer: 'yes' })]);
      expect(outcomes(refused)).toEqual([['confirm_pending_action', 'slot_unavailable']]);
      expect(await c.system.listAppointments(c.ctx(), { patientId: caller.record.id })).toEqual([]);
      c.expectNoSystemIdsReachedTheModel();
    });
  });
}
