import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeLanguageModel, type FakeRound } from '../../src/adapters/fakes/fake-llm.js';
import { MemorySchedulingSystem } from '../../src/adapters/fakes/memory-scheduling.js';
import { AppointmentTools } from '../../src/agent/tools/appointment-tools.js';
import { parseSchedulingDataset } from '../../src/contracts/scheduling-dataset.js';
import { ProviderError } from '../../src/core/errors.js';
import { silentLogger } from '../../src/core/logger.js';
import { instantToZoned } from '../../src/core/zoned-time.js';
import { type LanguageModel, type LlmEvent, type LlmRequest, type ToolExchange, isChatMessage } from '../../src/ports/language-model.js';
import type { SessionEvent, VoiceSession } from '../../src/voice/session.js';
import { FakeTransport } from '../support/fake-transport.js';
import { createHarness, waitFor } from '../support/session-harness.js';

/**
 * The voice session with appointment tools, end to end: scripted STT → scripted model ↔ real
 * AppointmentTools ↔ in-memory scheduling system → fake TTS/transport. The scripted model always asks
 * the server to confirm; the server decides from the caller's own words.
 */

const NOW = new Date('2026-10-11T05:00:00Z'); // Sunday 08:00 in Riyadh
const TENANT = { tenantId: 'demo', agentId: 'demo-clinic' };
const dataset = () => parseSchedulingDataset(JSON.parse(readFileSync('config/test-data/demo-clinic.dataset.json', 'utf8')));
const ctx = { tenant: TENANT, signal: new AbortController().signal };

const open: VoiceSession[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((s) => s.close('test_end')));
});

type Script = (request: LlmRequest, round: number) => FakeRound;

function setup(options: {
  script?: Script;
  llm?: LanguageModel;
  latencyMs?: number;
  agent?: { maxToolRounds?: number; toolMutationGraceMs?: number; toolWaitPhrase?: string };
  llmDelayMs?: number;
  /** Fraction of real time the fake client takes to play audio (default 0.05). */
  playbackSpeed?: number;
}) {
  const system = new MemorySchedulingSystem({ tenantId: TENANT.tenantId, dataset: dataset(), now: () => NOW, ...(options.latencyMs ? { latencyMs: options.latencyMs } : {}) });
  const tools = new AppointmentTools({
    scheduling: system,
    tenant: TENANT,
    sessionId: 'ses_tools',
    timeZone: 'Asia/Riyadh',
    log: silentLogger,
    verificationPolicy: 'dev-identifier-dob',
    now: () => NOW,
  });
  const llm = options.llm ?? new FakeLanguageModel({ script: options.script, firstTokenDelayMs: options.llmDelayMs ?? 5, tokenDelayMs: 1 });
  const h = createHarness({
    llm,
    tools,
    agent: { toolMutationGraceMs: 0, ...options.agent },
    ...(options.playbackSpeed !== undefined ? { transport: new FakeTransport({ playbackSpeed: options.playbackSpeed }) } : {}),
  });
  open.push(h.session);
  const toolEvents = () => h.events.filter((e): e is Extract<SessionEvent, { type: 'tool' }> => e.type === 'tool');
  return Object.assign(h, { system, tools, toolEvents }); // keeps the harness's lazy getters (sttStream)
}

// ───────────────────────────── scripted model helpers ─────────────────────────────

function lastUserText(request: LlmRequest): string {
  for (let i = request.messages.length - 1; i >= 0; i -= 1) {
    const m = request.messages[i];
    if (m && isChatMessage(m) && m.role === 'user') return m.text;
  }
  return '';
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

const call = (name: string, args: Record<string, unknown>, text?: string): FakeRound => ({ ...(text ? { text } : {}), toolCalls: [{ name, arguments: args }] });
const first = (output: Record<string, unknown> | undefined, list: string): Record<string, unknown> => {
  const item = (output?.[list] as Record<string, unknown>[] | undefined)?.[0];
  if (!item) throw new Error(`no ${list} in ${JSON.stringify(output)}`);
  return item;
};
const patientRef = (output: Record<string, unknown> | undefined): unknown => (output?.['patient'] as Record<string, unknown> | undefined)?.['ref'];

/**
 * A scripted model: in the turn whose caller text contains `opening` it runs `steps` (one tool round each)
 * and then says `closing`; in any later turn it asks the server to confirm `actionRef` and reports the result.
 */
function flow(opening: string, steps: ((out: Record<string, unknown>[]) => FakeRound)[], closing: string, actionRef = 'C1'): Script {
  return (request, round) => {
    const out = turnOutputs(request);
    if (lastUserText(request).includes(opening)) return round < steps.length ? (steps[round]?.(out) ?? { text: closing }) : { text: closing };
    if (round === 0) return call('confirm_pending_action', { action_ref: actionRef, caller_answer: 'yes' });
    return { text: out[0]?.['status'] === 'done' ? 'تم، الله يحفظك.' : `الحالة ${String(out[0]?.['status'])}.` };
  };
}

const BOOKING_STEPS = [
  () => call('find_patient', { national_id: '1000000500', phone: null, birth_date: '1978-01-25' }, 'لحظة أشيك لك.'),
  () => call('search_clinic_directory', { query: 'طب الأسرة', kind: 'service', service_ref: null }),
  (out: Record<string, unknown>[]) =>
    call('search_available_slots', { service_ref: first(out[1], 'results')['ref'], practitioner_ref: null, date_from: '2026-10-11', date_to: null, part_of_day: null, for_appointment_ref: null }),
  (out: Record<string, unknown>[]) => call('propose_booking', { patient_ref: patientRef(out[0]), slot_ref: first(out[2], 'slots')['ref'] }),
];
const bookingScript = (opening = 'أبي موعد') => flow(opening, BOOKING_STEPS, 'أحجز لك الموعد؟ ');

async function appointmentsOf(system: MemorySchedulingSystem, nationalId: string) {
  const [patient] = await system.findPatients(ctx, { nationalId });
  return system.listAppointments(ctx, { patientId: patient?.id ?? '' });
}

const summaries = (h: { sink: { summaries: { outcome: string }[] } }) => h.sink.summaries;
const requestFor = (llm: FakeLanguageModel, userText: string) => llm.calls.filter((c) => lastUserText(c) === userText);

// ───────────────────────────── workflows ─────────────────────────────

describe('VoiceSession with appointment tools — workflows', () => {
  it('books: tools across rounds, a spoken "one moment" before them, and the write only after the caller says yes', async () => {
    const h = setup({ script: bookingScript() });
    const llm = h.llm as FakeLanguageModel;
    await h.session.start();
    h.sttStream.commit('أبي موعد طب أسرة');
    await waitFor(() => summaries(h).length === 1, 8000, 'first turn');
    const firstTurn = h.sink.summaries[0];
    // No model round after the proposal: the system reads the details itself and the turn ends.
    expect(firstTurn).toMatchObject({ outcome: 'completed', llm_rounds: 4 });
    expect(firstTurn?.tool_calls?.map((c) => [c.name, c.outcome])).toEqual([
      ['find_patient', 'verified'],
      ['search_clinic_directory', 'ok'],
      ['search_available_slots', 'ok'],
      ['propose_booking', 'confirmation_required'],
    ]);
    expect(firstTurn?.durations_ms.tools_ms).toBeGreaterThanOrEqual(0);
    expect(await appointmentsOf(h.system, '1000000500')).toEqual([]);
    // The filler is spoken before the model waits on the next tools.
    const segmentAt = h.events.findIndex((e) => e.type === 'assistant_segment' && e.text === 'لحظة أشيك لك.');
    const laterToolAt = h.toolEvents().find((e) => e.name === 'search_available_slots' && e.phase === 'start');
    expect(segmentAt).toBeGreaterThanOrEqual(0);
    expect(segmentAt).toBeLessThan(h.events.indexOf(laterToolAt as SessionEvent));
    expect(h.toolEvents().filter((e) => e.phase === 'end').map((e) => e.outcome)).toEqual(['verified', 'ok', 'ok', 'confirmation_required']);
    // The read-back that reached TTS is the system's deterministic sentence; the model's own closing never ran.
    const spoken = (n: number) =>
      h.events.filter((e): e is Extract<SessionEvent, { type: 'assistant_segment' }> => e.type === 'assistant_segment' && e.turnId === h.sink.summaries[n]?.turn_id).map((e) => e.text).join(' ');
    expect(spoken(0)).toContain('للتأكيد: موعد تركي في طب الأسرة مع الدّكتور فهد العتيبي، يوم الأحد إحدعش أكتوبر، الساعة أربع مساءً. أثبّت الحجز؟');
    expect(spoken(0)).not.toContain('أحجز لك الموعد؟');

    h.sttStream.commit('إيه');
    await waitFor(() => summaries(h).length === 2, 8000, 'confirmation turn');
    expect(h.sink.summaries[1]?.tool_calls).toMatchObject([{ name: 'confirm_pending_action', outcome: 'done' }]);
    expect(await appointmentsOf(h.system, '1000000500')).toHaveLength(1);
    // The result is spoken from the record the scheduling system returned, not by the model.
    expect(spoken(1)).toBe('تم الحجز: موعد تركي في طب الأسرة مع الدّكتور فهد العتيبي، يوم الأحد إحدعش أكتوبر، الساعة أربع مساءً. تبي أخدمك بشي ثاني؟');
    expect(h.session.history().at(-1)?.text).toContain('تم الحجز');

    const [confirmRequest] = requestFor(llm, 'إيه');
    const earlier = confirmRequest?.messages.filter((m): m is ToolExchange => !isChatMessage(m)) ?? [];
    expect(earlier).toHaveLength(4); // the first turn's rounds, compact
    expect(earlier.every((e) => e.continuation === undefined)).toBe(true);
    expect(confirmRequest?.instructions).toContain('التاريخ والوقت الآن في العيادة: الأحد 2026-10-11');
  });

  it('never lets the model confirm its own proposal in the same turn: the turn ends with the read-back', async () => {
    const steps = [...BOOKING_STEPS, () => call('confirm_pending_action', { action_ref: 'C1', caller_answer: 'yes' })];
    const h = setup({ script: flow('أبي موعد', steps, 'أحجز؟ ') });
    await h.session.start();
    h.sttStream.commit('أبي موعد');
    await waitFor(() => summaries(h).length === 1, 8000);
    expect(h.sink.summaries[0]?.tool_calls?.at(-1)).toMatchObject({ name: 'propose_booking', outcome: 'confirmation_required' });
    expect(h.sink.summaries[0]?.tool_calls?.some((c) => c.name === 'confirm_pending_action')).toBe(false);
    expect(await appointmentsOf(h.system, '1000000500')).toEqual([]);
  });

  it('asks again after an unclear reply, books after a later clear yes, and changes nothing on a no', async () => {
    const h = setup({ script: bookingScript() });
    await h.session.start();
    h.sttStream.commit('أبي موعد');
    await waitFor(() => summaries(h).length === 1, 8000);
    h.sttStream.commit('إيه بس خله الساعة خمس');
    await waitFor(() => summaries(h).length === 2, 8000);
    expect(h.sink.summaries[1]?.tool_calls).toMatchObject([{ outcome: 'confirmation_unclear' }]);
    expect(await appointmentsOf(h.system, '1000000500')).toEqual([]);
    h.sttStream.commit('ايوه');
    await waitFor(() => summaries(h).length === 3, 8000);
    expect(h.sink.summaries[2]?.tool_calls).toMatchObject([{ outcome: 'done' }]);
    expect(await appointmentsOf(h.system, '1000000500')).toHaveLength(1);

    const declined = setup({ script: bookingScript() });
    await declined.session.start();
    declined.sttStream.commit('أبي موعد');
    await waitFor(() => summaries(declined).length === 1, 8000);
    declined.sttStream.commit('لا خلاص');
    await waitFor(() => summaries(declined).length === 2, 8000);
    expect(declined.sink.summaries[1]?.tool_calls).toMatchObject([{ outcome: 'declined' }]);
    expect(await appointmentsOf(declined.system, '1000000500')).toEqual([]);
  });

  it('reschedules within the same service after confirmation', async () => {
    const steps = [
      () => call('find_patient', { national_id: '1000000100', phone: null, birth_date: '1990-03-14' }),
      (out: Record<string, unknown>[]) => call('list_patient_appointments', { patient_ref: patientRef(out[0]) }),
      () => call('search_clinic_directory', { query: 'طب الأسرة', kind: 'service', service_ref: null }),
      (out: Record<string, unknown>[]) =>
        call('search_available_slots', {
          service_ref: first(out[2], 'results')['ref'],
          practitioner_ref: null,
          date_from: '2026-10-11',
          date_to: null,
          part_of_day: 'evening',
          for_appointment_ref: first(out[1], 'appointments')['ref'],
        }),
      (out: Record<string, unknown>[]) => call('propose_reschedule', { appointment_ref: first(out[1], 'appointments')['ref'], new_slot_ref: first(out[3], 'slots')['ref'] }),
    ];
    const h = setup({ script: flow('أأجل', steps, 'أنقله لك؟ ') });
    const [before] = await appointmentsOf(h.system, '1000000100');
    await h.session.start();
    h.sttStream.commit('أبي أأجل موعدي');
    await waitFor(() => summaries(h).length === 1, 8000);
    expect(h.sink.summaries[0]?.tool_calls?.at(-1)).toMatchObject({ name: 'propose_reschedule', outcome: 'confirmation_required' });
    h.sttStream.commit('إيه انقله');
    await waitFor(() => summaries(h).length === 2, 8000);
    expect(h.sink.summaries[1]?.tool_calls).toMatchObject([{ outcome: 'done' }]);
    const [after] = await appointmentsOf(h.system, '1000000100');
    expect(after?.id).toBe(before?.id);
    expect(after?.start.getTime()).not.toBe(before?.start.getTime());
    expect(instantToZoned(after?.start ?? new Date(0), 'Asia/Riyadh').minutes).toBeGreaterThanOrEqual(17 * 60);
  });

  it('cancels after confirmation', async () => {
    const steps = [
      () => call('find_patient', { national_id: '1000000200', phone: null, birth_date: '1985-07-02' }),
      (out: Record<string, unknown>[]) => call('list_patient_appointments', { patient_ref: patientRef(out[0]) }),
      (out: Record<string, unknown>[]) => call('propose_cancellation', { appointment_ref: first(out[1], 'appointments')['ref'], reason: null }),
    ];
    const h = setup({ script: flow('أبي ألغي', steps, 'ألغيه؟ ') });
    await h.session.start();
    h.sttStream.commit('أبي ألغي موعدي');
    await waitFor(() => summaries(h).length === 1, 8000);
    h.sttStream.commit('إيه ألغيه');
    await waitFor(() => summaries(h).length === 2, 8000);
    expect(h.sink.summaries[1]?.tool_calls).toMatchObject([{ outcome: 'done' }]);
    expect(await appointmentsOf(h.system, '1000000200')).toHaveLength(1); // one of two left
  });
});

// ───────────────────────────── interruptions & the write ledger ─────────────────────────────

describe('VoiceSession with appointment tools — the read-back the caller confirms (plan step 8)', () => {
  const READ_BACK = 'للتأكيد: موعد تركي في طب الأسرة مع الدّكتور فهد العتيبي، يوم الأحد إحدعش أكتوبر، الساعة أربع مساءً. أثبّت الحجز؟';
  const spokenIn = (h: ReturnType<typeof setup>, n: number) =>
    h.events.filter((e): e is Extract<SessionEvent, { type: 'assistant_segment' }> => e.type === 'assistant_segment' && e.turnId === h.sink.summaries[n]?.turn_id).map((e) => e.text).join(' ');

  it('does not book on a yes when the model spoke another date in the read-back turn: the system reads the details again first', async () => {
    const steps = [...BOOKING_STEPS];
    // The model words a wrong date itself before proposing (what was observed live: the 15th for the 13th).
    steps[3] = (out: Record<string, unknown>[]) => call('propose_booking', { patient_ref: patientRef(out[0]), slot_ref: first(out[2], 'slots')['ref'] }, 'تمام، بحجز لك يوم الخميس خمسطعش أكتوبر.');
    const h = setup({ script: flow('أبي موعد', steps, 'أحجز؟ ') });
    await h.session.start();
    h.sttStream.commit('أبي موعد');
    await waitFor(() => summaries(h).length === 1, 8000);
    expect(spokenIn(h, 0)).toContain(READ_BACK);

    h.sttStream.commit('إيه');
    await waitFor(() => summaries(h).length === 2, 8000);
    expect(h.sink.summaries[1]?.tool_calls).toMatchObject([{ name: 'confirm_pending_action', outcome: 'read_back_required' }]);
    expect(await appointmentsOf(h.system, '1000000500')).toEqual([]);
    expect(spokenIn(h, 1)).toBe(`خلني أعيد لك التفاصيل. ${READ_BACK}`);

    h.sttStream.commit('إيه');
    await waitFor(() => summaries(h).length === 3, 8000);
    expect(h.sink.summaries[2]?.tool_calls).toMatchObject([{ name: 'confirm_pending_action', outcome: 'done' }]);
    const [booked] = await appointmentsOf(h.system, '1000000500');
    expect(instantToZoned(booked?.start ?? new Date(0), 'Asia/Riyadh')).toMatchObject({ date: '2026-10-11', time: '16:00' }); // the read-back's date, not the model's
  });

  it('says the wait phrase before the first tool when the model said nothing, once per turn, and not when it did', async () => {
    const silentSteps = BOOKING_STEPS.map((step) => (out: Record<string, unknown>[]) => ({ ...step(out), text: undefined }));
    const h = setup({ script: flow('أبي موعد', silentSteps, 'أحجز؟ '), agent: { toolWaitPhrase: 'لحظة أشيك لك.' } });
    await h.session.start();
    h.sttStream.commit('أبي موعد');
    await waitFor(() => summaries(h).length === 1, 8000);
    const segments = h.events.filter((e): e is Extract<SessionEvent, { type: 'assistant_segment' }> => e.type === 'assistant_segment').map((e) => e.text);
    expect(segments[0]).toBe('لحظة أشيك لك.');
    expect(segments.filter((s) => s === 'لحظة أشيك لك.')).toHaveLength(1); // once, though four tools ran
    // Spoken while the first tools run (flushed to TTS in parallel), well before the later ones.
    const laterToolAt = h.events.findIndex((e) => e.type === 'tool' && e.name === 'search_available_slots');
    expect(h.events.findIndex((e) => e.type === 'assistant_segment')).toBeLessThan(laterToolAt);
    expect(spokenIn(h, 0)).toContain(READ_BACK); // the read-back check is not disturbed by the phrase

    const talkative = setup({ script: bookingScript(), agent: { toolWaitPhrase: 'لحظة أشيك لك.' } }); // the model says its own "one moment"
    await talkative.session.start();
    talkative.sttStream.commit('أبي موعد');
    await waitFor(() => summaries(talkative).length === 1, 8000);
    expect(talkative.events.filter((e) => e.type === 'assistant_segment' && e.text === 'لحظة أشيك لك.')).toHaveLength(1);
  });

  it('does not book on a yes said over an interrupted read-back: the system reads it again, the next yes books', async () => {
    const h = setup({ script: bookingScript(), playbackSpeed: 0.5 });
    await h.session.start();
    h.sttStream.commit('أبي موعد');
    await waitFor(() => h.session.currentState === 'speaking' && h.events.some((e) => e.type === 'assistant_segment' && e.text.startsWith('للتأكيد')), 8000, 'read-back playing');
    h.sttStream.partial('إيه احجزه لو سمحت'); // barge-in before the date and time were heard
    await waitFor(() => summaries(h).length === 1, 5000);
    expect(h.sink.summaries[0]).toMatchObject({ outcome: 'interrupted' });

    h.sttStream.commit('إيه احجزه لو سمحت');
    await waitFor(() => summaries(h).length === 2, 8000);
    expect(h.sink.summaries[1]?.tool_calls).toMatchObject([{ name: 'confirm_pending_action', outcome: 'read_back_required' }]);
    expect(await appointmentsOf(h.system, '1000000500')).toEqual([]);
    expect(spokenIn(h, 1)).toContain(READ_BACK);

    h.sttStream.commit('إيه');
    await waitFor(() => summaries(h).length === 3, 10_000);
    expect(h.sink.summaries[2]?.tool_calls).toMatchObject([{ name: 'confirm_pending_action', outcome: 'done' }]);
    expect(await appointmentsOf(h.system, '1000000500')).toHaveLength(1);
  });
});

describe('VoiceSession with appointment tools — interruptions and writes', () => {
  it('completes a confirmed write when the caller barges in, and records it before the next turn', async () => {
    const script: Script = (request, round) => {
      const user = lastUserText(request);
      if (user.includes('أبي موعد')) return round < BOOKING_STEPS.length ? (BOOKING_STEPS[round]?.(turnOutputs(request)) ?? { text: '' }) : { text: 'أحجز؟ ' };
      if (user === 'إيه') return round === 0 ? call('confirm_pending_action', { action_ref: 'C1', caller_answer: 'yes' }, 'تمام، لحظة أأكد الحجز.') : { text: 'تم.' };
      return { text: 'إيه عندنا مواقف.' };
    };
    const h = setup({ script, latencyMs: 300 });
    const llm = h.llm as FakeLanguageModel;
    await h.session.start();
    h.sttStream.commit('أبي موعد');
    await waitFor(() => summaries(h).length === 1, 10_000);

    h.sttStream.commit('إيه');
    await waitFor(() => h.session.currentState === 'speaking' && h.toolEvents().some((e) => e.name === 'confirm_pending_action' && e.phase === 'start'), 5000, 'write in flight');
    h.sttStream.partial('لا لحظة عندي سؤال');
    await waitFor(() => summaries(h).length === 2, 5000);
    expect(h.sink.summaries[1]).toMatchObject({ outcome: 'interrupted' });

    h.sttStream.commit('عندكم مواقف سيارات؟');
    await waitFor(() => summaries(h).length === 3, 10_000);
    expect(await appointmentsOf(h.system, '1000000500')).toHaveLength(1);
    const [nextRequest] = requestFor(llm, 'عندكم مواقف سيارات؟');
    const items = nextRequest?.messages ?? [];
    const writeAt = items.findIndex((m) => !isChatMessage(m) && m.calls.some((c) => c.name === 'confirm_pending_action'));
    expect(writeAt).toBeGreaterThan(-1);
    expect(writeAt).toBeLessThan(items.length - 1); // before the new user message
    const write = items[writeAt] as ToolExchange;
    expect(JSON.parse(write.results[0]?.output ?? '{}')).toMatchObject({ status: 'done' });
  });

  it('does not merge a turn that ran a write into the next utterance when the caller keeps talking', async () => {
    const script: Script = (request, round) => {
      const user = lastUserText(request);
      if (user.includes('أبي موعد')) return round < BOOKING_STEPS.length ? (BOOKING_STEPS[round]?.(turnOutputs(request)) ?? { text: '' }) : { text: 'أحجز؟ ' };
      if (user === 'إيه') return round === 0 ? call('confirm_pending_action', { action_ref: 'C1', caller_answer: 'yes' }) : { text: 'تم.' };
      return { text: 'أبشر.' };
    };
    const h = setup({ script, latencyMs: 300 });
    const llm = h.llm as FakeLanguageModel;
    await h.session.start();
    h.sttStream.commit('أبي موعد');
    await waitFor(() => summaries(h).length === 1, 10_000);
    h.sttStream.commit('إيه');
    await waitFor(() => h.toolEvents().some((e) => e.name === 'confirm_pending_action' && e.phase === 'start'), 5000, 'write started');
    h.sttStream.partial('وكمان');
    await waitFor(() => summaries(h).length === 2, 5000);
    expect(h.sink.summaries[1]).toMatchObject({ outcome: 'cancelled', reason: 'user_continued' });

    h.sttStream.commit('وكمان أبي أسأل عن الدوام');
    await waitFor(() => summaries(h).length === 3, 10_000);
    const [nextRequest] = requestFor(llm, 'وكمان أبي أسأل عن الدوام'); // not merged with "إيه"
    expect(nextRequest).toBeDefined();
    const users = (nextRequest?.messages ?? []).filter((m) => isChatMessage(m) && m.role === 'user').map((m) => m.text);
    expect(users.slice(-2)).toEqual(['إيه', 'وكمان أبي أسأل عن الدوام']);
    expect(nextRequest?.messages.some((m) => !isChatMessage(m) && m.calls.some((c) => c.name === 'confirm_pending_action'))).toBe(true);
    expect(await appointmentsOf(h.system, '1000000500')).toHaveLength(1);
  });

  it('cancels a write during its grace period when the caller keeps talking ("yes… but")', async () => {
    const h = setup({ script: bookingScript(), agent: { toolMutationGraceMs: 400 } });
    const llm = h.llm as FakeLanguageModel;
    await h.session.start();
    h.sttStream.commit('أبي موعد');
    await waitFor(() => summaries(h).length === 1, 8000);
    h.sttStream.commit('إيه');
    await waitFor(() => requestFor(llm, 'إيه').length === 1, 3000, 'confirmation round requested');
    await waitFor(() => llm.completed >= 5, 3000, 'model asked to confirm'); // 4 rounds in the first turn, then the confirm call
    h.sttStream.partial('بس خله');
    h.sttStream.commit('بس خله الساعة خمس');
    await waitFor(() => summaries(h).length === 3, 8000);
    expect(h.toolEvents().filter((e) => e.name === 'confirm_pending_action' && e.phase === 'end').map((e) => e.outcome)).toEqual(['confirmation_unclear']);
    expect(requestFor(llm, 'إيه بس خله الساعة خمس').length).toBeGreaterThan(0); // merged: same caller turn
    expect(await appointmentsOf(h.system, '1000000500')).toEqual([]);
  });

  it('waits for an in-flight write before the session closes', async () => {
    const h = setup({ script: bookingScript(), latencyMs: 250 });
    await h.session.start();
    h.sttStream.commit('أبي موعد');
    await waitFor(() => summaries(h).length === 1, 10_000);
    h.sttStream.commit('إيه');
    let bookFinished = false;
    const book = h.system.book.bind(h.system);
    h.system.book = async (c, request) => {
      const result = await book(c, request);
      bookFinished = true;
      return result;
    };
    await waitFor(() => h.toolEvents().some((e) => e.name === 'confirm_pending_action' && e.phase === 'start'), 5000);
    await h.session.close('caller_hung_up');
    expect(bookFinished).toBe(true); // close() itself waited for the write
    expect(await appointmentsOf(h.system, '1000000500')).toHaveLength(1);
  });

  it('reconciles an unknown write outcome at the start of the next turn and tells the model', async () => {
    const h = setup({ script: bookingScript() });
    const llm = h.llm as FakeLanguageModel;
    await h.session.start();
    h.sttStream.commit('أبي موعد');
    await waitFor(() => summaries(h).length === 1, 8000);
    h.system.failNext('book', new ProviderError('memory', 'unavailable', 'reply lost'), { afterCommit: true });
    h.system.failNext('listAppointments', new ProviderError('memory', 'unavailable', 'still down'));
    h.sttStream.commit('إيه');
    await waitFor(() => summaries(h).length === 2, 8000);
    expect(h.sink.summaries[1]?.tool_calls).toMatchObject([{ outcome: 'outcome_unknown' }]);
    h.sttStream.commit('طيب وش صار؟');
    await waitFor(() => summaries(h).length === 3, 8000);
    const [request] = requestFor(llm, 'طيب وش صار؟');
    expect(request?.instructions).toContain('تحديث من النظام');
    expect(request?.instructions).toContain('C1 (booking) تم تنفيذه فعلًا');
  });

  it('drops a proposal the caller never heard', async () => {
    // No filler: nothing is spoken before the proposal, so cutting the turn short means nothing was heard.
    const silentSteps = [() => call('find_patient', { national_id: '1000000500', phone: null, birth_date: '1978-01-25' }), ...BOOKING_STEPS.slice(1)];
    const script: Script = (request, round) => {
      if (lastUserText(request) === 'أبي موعد طب أسرة') return round < silentSteps.length ? (silentSteps[round]?.(turnOutputs(request)) ?? { text: '' }) : { text: 'أحجز؟ ' };
      return round === 0 ? call('confirm_pending_action', { action_ref: 'C1', caller_answer: 'yes' }) : { text: 'طيب.' };
    };
    const h = setup({ script, llmDelayMs: 150 });
    await h.session.start();
    h.sttStream.commit('أبي موعد طب أسرة');
    await waitFor(() => h.toolEvents().some((e) => e.name === 'propose_booking' && e.phase === 'end'), 8000, 'proposal made');
    h.sttStream.partial('وكمان');
    h.sttStream.commit('وكمان شي ثاني');
    await waitFor(() => h.toolEvents().filter((e) => e.name === 'confirm_pending_action' && e.phase === 'end').length === 1, 8000);
    // Same caller turn (merged), but the unheard proposal is gone rather than pending.
    expect(h.toolEvents().find((e) => e.name === 'confirm_pending_action' && e.phase === 'end')?.outcome).toBe('expired');
  });
});

// ───────────────────────────── failures & limits ─────────────────────────────

describe('VoiceSession with appointment tools — failures and limits', () => {
  it('reports a slot taken before confirmation, and a scheduling outage, without breaking the call', async () => {
    const h = setup({ script: bookingScript() });
    await h.session.start();
    h.sttStream.commit('أبي موعد');
    await waitFor(() => summaries(h).length === 1, 8000);
    // Someone else takes the same time.
    const [other] = await h.system.findPatients(ctx, { nationalId: '1000000100' });
    const service = (await h.system.searchDirectory(ctx, { text: 'طب الأسرة', kind: 'service', limit: 1 })).entries[0];
    const { slots } = await h.system.findAvailability(ctx, {
      serviceId: service?.kind === 'service' ? service.service.id : '',
      from: NOW,
      to: new Date(NOW.getTime() + 7 * 86_400_000),
      limit: 1,
    });
    await h.system.book(ctx, { patientId: other?.id ?? '', slot: slots[0]!, idempotencyKey: 'other' });
    h.sttStream.commit('إيه');
    await waitFor(() => summaries(h).length === 2, 8000);
    expect(h.sink.summaries[1]).toMatchObject({ outcome: 'completed', tool_calls: [{ outcome: 'slot_unavailable' }] });
    expect(await appointmentsOf(h.system, '1000000500')).toEqual([]);

    const outage = setup({ script: bookingScript() });
    outage.system.failNext('findAvailability', new ProviderError('memory', 'unavailable', 'down'));
    await outage.session.start();
    outage.sttStream.commit('أبي موعد');
    await waitFor(() => summaries(outage).length === 1, 8000);
    expect(outage.sink.summaries[0]?.tool_calls?.map((c) => c.outcome)).toContain('system_unavailable');
    expect(outage.session.currentState).toBe('listening');
  });

  it('fails the turn cleanly when the model errors or stalls mid-loop, keeping finished tool rounds', async () => {
    let calls = 0;
    const failing: LanguageModel = {
      name: 'flaky',
      async *stream(): AsyncGenerator<LlmEvent> {
        await Promise.resolve();
        calls += 1;
        if (calls === 1) {
          yield { type: 'completed', toolCalls: [{ callId: 'c1', name: 'search_clinic_directory', arguments: '{"query":"جلدية","kind":"service","service_ref":null}' }] };
          return;
        }
        if (calls === 2) throw new ProviderError('flaky', 'unavailable', 'boom');
        yield { type: 'text_delta', text: 'هلا.' };
        yield { type: 'completed' };
      },
    };
    const h = setup({ llm: failing });
    await h.session.start();
    h.sttStream.commit('عندكم جلدية؟');
    await waitFor(() => summaries(h).length === 1, 5000);
    expect(h.sink.summaries[0]).toMatchObject({ outcome: 'error', tool_calls: [{ name: 'search_clinic_directory', outcome: 'ok' }] });
    expect(h.events.some((e) => e.type === 'error' && e.code === 'turn_unavailable')).toBe(true);
    expect(h.session.currentState).toBe('listening');
    h.sttStream.commit('طيب');
    await waitFor(() => summaries(h).length === 2, 5000);
    expect(h.sink.summaries[1]).toMatchObject({ outcome: 'completed' });

    let stallCalls = 0;
    const stalling: LanguageModel = {
      name: 'stall',
      async *stream(_request, { signal }): AsyncGenerator<LlmEvent> {
        stallCalls += 1;
        if (stallCalls === 1) {
          yield { type: 'completed', toolCalls: [{ callId: 'c1', name: 'search_clinic_directory', arguments: '{"query":"x","kind":"any","service_ref":null}' }] };
          return;
        }
        await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason as Error)));
      },
    };
    const s = setup({ llm: stalling });
    await s.session.start();
    s.sttStream.commit('سؤال');
    await waitFor(() => summaries(s).length === 1, 5000);
    expect(s.sink.summaries[0]).toMatchObject({ outcome: 'error', error: { error_kind: 'timeout' } });
  });

  it('stops offering tools after the round limit and makes the model answer in text', async () => {
    const h = setup({ script: () => call('search_clinic_directory', { query: 'x', kind: 'any', service_ref: null }, 'لحظة.'), agent: { maxToolRounds: 2 } });
    const llm = h.llm as FakeLanguageModel;
    await h.session.start();
    h.sttStream.commit('سؤال طويل');
    await waitFor(() => summaries(h).length === 1, 8000);
    expect(h.sink.summaries[0]).toMatchObject({ outcome: 'completed', llm_rounds: 3 });
    expect(h.sink.summaries[0]?.tool_calls).toHaveLength(2);
    expect(llm.calls.map((c) => c.toolChoice)).toEqual(['auto', 'auto', 'none']);
  });
});
