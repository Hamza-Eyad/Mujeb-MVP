import { afterAll, describe, expect, it } from 'vitest';
import { type AgentToolbox, AgentTurn } from '../../src/agent/agent-turn.js';
import { Conversation } from '../../src/agent/conversation.js';
import { AppointmentTools, type ToolCallResult, type ToolTurnContext } from '../../src/agent/tools/appointment-tools.js';
import { loadAgentProfile } from '../../src/app/agent-profile.js';
import { createProviders } from '../../src/app/container.js';
import { type Settings, loadSettings } from '../../src/config/settings.js';
import { silentLogger } from '../../src/core/logger.js';
import { spokenDateTime } from '../../src/agent/tools/spoken-arabic.js';
import { type LocalDate, zonedToInstant } from '../../src/core/zoned-time.js';
import type { LanguageModel, LlmEvent, LlmRequest } from '../../src/ports/language-model.js';
import { LIVE_MEDPLUM_ENABLED, LIVE_TENANT, type LiveMedplum, connectLiveMedplum } from '../support/live-medplum.js';

/**
 * The real language model (OpenAI Responses API, `store: false`) driving Mujeeb's appointment tools on the
 * Medplum sandbox — the agent loop VoiceSession uses, without audio. Natural Saudi-Arabic caller turns;
 * checks tool selection, multi-round tool use within a turn, provider-state replay (reasoning /
 * encrypted_content / phase), server-side confirmation, and failure handling. Paid and opt-in:
 *
 *   MUJEEB_LIVE_MEDPLUM=1 MEDPLUM_CLIENT_ID=… MEDPLUM_CLIENT_SECRET=… npx vitest run --config vitest.live.config.ts tests/live/agent-tools.live.test.ts
 *
 * Writes only for patients registered by the test; everything it books is cancelled at the end.
 */

const env = process.env;
const ENABLED = LIVE_MEDPLUM_ENABLED && Boolean(env['OPENAI_API_KEY'] && env['MUJEEB_LLM_MODEL']);

interface Round {
  turnId: string;
  ttftMs: number | undefined;
  ms: number;
  calls: string[];
  /** Output item types of a round that called tools, e.g. `reasoning+enc`, `message:commentary`, `function_call`. */
  items: string[];
}

/** Records every model round; the provider continuation is inspected here only (domain code never does). */
class RecordingModel implements LanguageModel {
  readonly name: string;
  readonly rounds: Round[] = [];
  turnId = '';
  constructor(private readonly inner: LanguageModel) {
    this.name = inner.name;
  }
  async *stream(request: LlmRequest, options: { signal: AbortSignal }): AsyncGenerator<LlmEvent> {
    const started = performance.now();
    const round: Round = { turnId: this.turnId, ttftMs: undefined, ms: 0, calls: [], items: [] };
    this.rounds.push(round);
    for await (const event of this.inner.stream(request, options)) {
      round.ttftMs ??= performance.now() - started;
      if (event.type === 'completed') {
        round.calls = (event.toolCalls ?? []).map((c) => c.name);
        round.items = (event.continuation?.items ?? []).map(describeItem);
        round.ms = performance.now() - started;
      }
      yield event;
    }
  }
}

function describeItem(raw: unknown): string {
  const item = raw as { type?: string; encrypted_content?: unknown; phase?: unknown };
  if (item.type === 'reasoning') return typeof item.encrypted_content === 'string' && item.encrypted_content !== '' ? 'reasoning+enc' : 'reasoning(no-enc)';
  if (item.type === 'message') return `message:${typeof item.phase === 'string' ? item.phase : 'no-phase'}`;
  return String(item.type);
}

interface ToolRecord {
  turnId: string;
  name: string;
  outcome: string;
  output: Record<string, unknown>;
}

/** The real tools, recording each call's result for the test (outputs are never printed). */
class RecordingToolbox implements AgentToolbox {
  readonly calls: ToolRecord[] = [];
  constructor(private readonly inner: AppointmentTools) {}
  definitions() {
    return this.inner.definitions();
  }
  async execute(name: string, rawArguments: string, turn: ToolTurnContext): Promise<ToolCallResult> {
    const result = await this.inner.execute(name, rawArguments, turn);
    this.calls.push({ turnId: turn.turnId, name, outcome: result.outcome, output: result.output });
    return result;
  }
  mutates(name: string) {
    return this.inner.mutates(name);
  }
  contextNote() {
    return this.inner.contextNote();
  }
  onTurnFinalized(turnId: string, heardAnything: boolean, heardText?: string) {
    this.inner.onTurnFinalized(turnId, heardAnything, heardText);
  }
  reconcileUnresolved() {
    return this.inner.reconcileUnresolved();
  }
  drain(timeoutMs: number) {
    return this.inner.drain(timeoutMs);
  }
}

interface TurnResult {
  turnId: string;
  user: string;
  reply: string;
  tools: ToolRecord[];
  rounds: number;
  ms: number;
  firstTextMs: number | undefined;
  toolsMs: number;
}

let callSeq = 0;
async function startCall(m: LiveMedplum, overrides: Record<string, string> = {}) {
  const settings: Settings = loadSettings({ ...env, MUJEEB_STT_PROVIDER: 'fake', MUJEEB_TTS_PROVIDER: 'fake', ...overrides });
  const profile = await loadAgentProfile(settings.agentProfilePath);
  const toolsProfile = profile.appointmentTools;
  if (!toolsProfile || profile.timezone === undefined) throw new Error('agent profile without appointment tools');
  const model = new RecordingModel(createProviders(settings).llm); // the production composition (container)
  const tools = new RecordingToolbox(
    new AppointmentTools({
      scheduling: m.guarded,
      tenant: LIVE_TENANT,
      sessionId: `ses_live_llm_${Date.now()}_${(callSeq += 1)}`,
      timeZone: profile.timezone,
      log: silentLogger,
      verificationPolicy: toolsProfile.patientVerification,
      pendingActionTtlMs: toolsProfile.pendingActionTtlSec * 1000,
      maxReconfirmations: toolsProfile.maxReconfirmations,
      readTimeoutMs: settings.scheduling.readTimeoutMs,
      writeTimeoutMs: settings.scheduling.writeTimeoutMs,
    }),
  );
  const conversation = new Conversation({ instructions: `${profile.instructions}\n\n${toolsProfile.instructions}`, maxTurns: profile.historyMaxTurns });
  if (profile.greeting) conversation.addAssistant(profile.greeting);
  const transcript: TurnResult[] = [];
  let userTurn = 0;

  const say = async (text: string): Promise<TurnResult> => {
    userTurn += 1;
    const turnId = `call${callSeq}-t${userTurn}`;
    model.turnId = turnId;
    const started = performance.now();
    const notes = (await tools.reconcileUnresolved()).map((r) => `تحديث من النظام: الإجراء ${r.action_ref} (${r.kind}) ${r.applied ? 'تم تنفيذه فعلًا' : 'لم يُنفذ'}.`);
    const agent = new AgentTurn({
      llm: model,
      conversation,
      tools,
      userText: text,
      userTurn,
      turnId,
      signal: AbortSignal.timeout(120_000),
      maxToolRounds: toolsProfile.maxToolRounds,
      firstEventTimeoutMs: settings.llm.firstTokenTimeoutMs,
      mutationGraceMs: 0,
      notes,
    });
    let reply = '';
    let firstTextMs: number | undefined;
    for await (const out of agent.output) {
      if (out.type !== 'text') {
        reply += ' '; // a pause before a tool: the voice path sends the text before it as its own TTS segment
        continue;
      }
      firstTextMs ??= performance.now() - started;
      reply += out.text;
    }
    await agent.done;
    conversation.commitTurn({ user: text, exchanges: agent.exchanges, assistant: reply });
    // Without audio, the whole reply is what TTS would get and the caller would hear.
    tools.onTurnFinalized(turnId, true, reply);
    const result: TurnResult = { turnId, user: text, reply, tools: tools.calls.filter((c) => c.turnId === turnId), rounds: agent.rounds, ms: performance.now() - started, firstTextMs, toolsMs: agent.toolsMs };
    transcript.push(result);
    print(result, model.rounds.filter((r) => r.turnId === turnId));
    return result;
  };

  /** Plays caller turns until `goal` holds for a turn (the model may take different, valid paths). */
  const until = async (goal: (t: TurnResult) => boolean, utterances: string[]): Promise<TurnResult> => {
    for (const u of utterances) {
      const t = await say(u);
      if (goal(t)) return t;
    }
    throw new Error(`goal not reached after ${utterances.length} turns`);
  };
  return { say, until, model, tools, transcript, settings };
}

const has = (t: TurnResult, name: string, outcome?: string): boolean => t.tools.some((c) => c.name === name && (outcome === undefined || c.outcome === outcome));
const lastOutput = (t: TurnResult, name: string): Record<string, unknown> | undefined => [...t.tools].reverse().find((c) => c.name === name)?.output;
const str = (v: unknown): string => {
  if (typeof v !== 'string') throw new Error(`expected a string, got ${JSON.stringify(v)}`);
  return v;
};

function print(t: TurnResult, rounds: Round[]): void {
  const masked = (s: string) => s.replace(/\d{6,}/g, '…');
  const lines = [
    `\n[live-llm] ${t.turnId}  user: ${masked(t.user)}`,
    `  tools: ${t.tools.map((c) => `${c.name}→${c.outcome}`).join(', ') || '-'}`,
    ...rounds.map((r, i) => `  round ${i + 1}: ttft=${Math.round(r.ttftMs ?? -1)}ms total=${Math.round(r.ms)}ms calls=[${r.calls.join(',')}] items=[${r.items.join(',')}]`),
    `  turn: ${Math.round(t.ms)}ms, first text ${t.firstTextMs !== undefined ? `${Math.round(t.firstTextMs)}ms` : '-'}, tools ${Math.round(t.toolsMs)}ms, rounds ${t.rounds}`,
    `  mujeeb: ${masked(t.reply.trim())}`,
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
}

let live: Promise<LiveMedplum> | undefined;
const connect = (): Promise<LiveMedplum> => (live ??= connectLiveMedplum());

describe.skipIf(!ENABLED)('live: OpenAI tool calling with the appointment tools on Medplum', () => {
  afterAll(async () => {
    if (!live) return;
    const result = await (await live).cleanup();
    process.stdout.write(`\n[live-llm] cleanup: ${result.cancelled} leftover appointment(s) cancelled\n`);
  });

  it('verifies a caller and lists their appointments: several tool rounds in one turn, no IDs or digits spoken', async () => {
    const m = await connect();
    const call = await startCall(m);
    const one = m.dataset.patients.find((p) => p.key === 'patient-one-upcoming');
    if (!one) throw new Error('dataset patient missing');
    const t = await call.until((r) => has(r, 'list_patient_appointments', 'ok'), [
      `السلام عليكم، أبي أعرف مواعيدي. رقم هويتي ${one.nationalId} وتاريخ ميلادي أربعطعش مارس ألف وتسعمية وتسعين`,
      'وش مواعيدي القادمة؟',
    ]);
    expect(call.tools.calls.find((c) => c.name === 'find_patient' && c.outcome === 'verified')).toBeDefined();
    expect(t.reply.trim().length).toBeGreaterThan(0);
    expect(t.reply).toMatch(/فهد/); // the seeded appointment is with Dr. Fahad
    expect(t.reply).not.toMatch(/\b[VDSPAC]\d+\b/); // internal refs are never spoken
    // Several model rounds with tool calls in one user turn worked with store:false (each round replays the previous one).
    expect(call.model.rounds.filter((r) => r.calls.length > 0).length).toBeGreaterThanOrEqual(2);
  }, 300_000);

  it('books, reschedules and cancels for a verified caller, executing only after the caller says yes', async () => {
    const m = await connect();
    const caller = await m.registerTestPatient('الحوار');
    const call = await startCall(m);

    const proposed = await call.until((t) => has(t, 'propose_booking', 'confirmation_required'), [
      `السلام عليكم، أبي أحجز موعد في الجلدية. رقم هويتي ${caller.nationalId} وتاريخ ميلادي ثلاثة فبراير ألف وتسعمية وواحد وتسعين`,
      'أي وقت يناسبني، اختر أقرب موعد متاح',
      'الوقت الأول تمام، احجزه',
      'إيه الأول',
    ]);
    expect(has(proposed, 'confirm_pending_action', 'done')).toBe(false);
    expect(await m.system.listAppointments(m.ctx(), { patientId: caller.record.id })).toEqual([]); // nothing written before the yes
    // The read-back reaching TTS is the system's sentence, verbatim, and it ends the turn.
    const readBack = str(lastOutput(proposed, 'propose_booking')?.['spoken']);
    expect(proposed.reply.trim().endsWith(readBack)).toBe(true);
    const booked = await call.say('ثبّت الحجز'); // the natural answer to "أثبّت الحجز؟"
    expect(has(booked, 'confirm_pending_action', 'done')).toBe(true);
    const [appointment] = await m.system.listAppointments(m.ctx(), { patientId: caller.record.id });
    expect(appointment).toMatchObject({ status: 'booked', serviceName: 'الجلدية' });
    // The date and time the caller heard and agreed to are those of the appointment Medplum holds.
    const heldAt = spokenDateTime(appointment?.start ?? new Date(0), m.timeZone, new Date());
    expect(readBack).toContain(heldAt);
    expect(booked.reply).toContain(heldAt);

    await call.until((t) => has(t, 'propose_reschedule', 'confirmation_required'), [
      'أبي أغيّر الموعد لوقت ثاني، يوم بعده',
      'أي وقت ثاني متاح يناسبني، اختر الأقرب',
      'الوقت الأول اللي عرضته تمام',
    ]);
    const moved = await call.say('إيه ثبّت');
    expect(has(moved, 'confirm_pending_action', 'done')).toBe(true);
    const [after] = await m.system.listAppointments(m.ctx(), { patientId: caller.record.id });
    expect(after?.id).toBe(appointment?.id);
    expect(after?.start.getTime()).not.toBe(appointment?.start.getTime());
    expect(moved.reply).toContain(spokenDateTime(after?.start ?? new Date(0), m.timeZone, new Date())); // the new date, as Medplum holds it

    await call.until((t) => has(t, 'propose_cancellation', 'confirmation_required'), ['خلاص أبي ألغي موعدي', 'ألغ الموعد لو سمحت']);
    const cancelled = await call.say('توكل على الله');
    expect(has(cancelled, 'confirm_pending_action', 'done')).toBe(true);
    expect(await m.system.listAppointments(m.ctx(), { patientId: caller.record.id })).toEqual([]);
    // Every write happened in a turn where the caller had just said yes.
    const yesTurns = call.transcript.filter((x) => has(x, 'confirm_pending_action', 'done')).map((t) => t.user);
    expect(yesTurns).toEqual(['ثبّت الحجز', 'إيه ثبّت', 'توكل على الله']);
  }, 600_000);

  it('handles a slot taken before the caller confirms: no booking, an apology and new options', async () => {
    const m = await connect();
    const caller = await m.registerTestPatient('حوار التعارض');
    const rival = await m.registerTestPatient('حوار المنافس');
    const call = await startCall(m);
    const proposed = await call.until((t) => has(t, 'propose_booking', 'confirmation_required'), [
      `هلا، أبي موعد طب أسرة. رقم هويتي ${caller.nationalId} وتاريخ ميلادي ثلاثة فبراير ألف وتسعمية وواحد وتسعين`,
      'أي وقت يناسبني، اختر أقرب موعد متاح',
      'الوقت الأول تمام، احجزه',
      'إيه الأول',
    ]);
    // Someone else takes the proposed time before the caller answers.
    const readBack = lastOutput(proposed, 'propose_booking')?.['read_back'] as { date: LocalDate; time: string; doctor: string } | undefined;
    if (!readBack) throw new Error('no read_back');
    const start = zonedToInstant(readBack.date, readBack.time, m.timeZone);
    const { entries } = await m.system.searchDirectory(m.ctx(), { text: 'طب الأسرة', kind: 'service', limit: 1 });
    const serviceId = entries[0]?.kind === 'service' ? entries[0].service.id : '';
    const slot = (await m.system.findAvailability(m.ctx(), { serviceId, from: start, to: new Date(start.getTime() + 60_000), limit: 5 })).slots.find(
      (s) => s.practitionerName === readBack.doctor,
    );
    if (!slot) throw new Error('proposed slot not found');
    await m.guarded.book(m.ctx(), { patientId: rival.record.id, slot, idempotencyKey: `rival-${Date.now()}` });

    const refused = await call.say('إيه');
    expect(has(refused, 'confirm_pending_action', 'slot_unavailable')).toBe(true);
    expect(has(refused, 'confirm_pending_action', 'done')).toBe(false);
    expect(refused.reply.trim().length).toBeGreaterThan(0);
    expect(await m.system.listAppointments(m.ctx(), { patientId: caller.record.id })).toEqual([]);
    process.stdout.write(`\n[live-llm] after slot_unavailable the model ${has(refused, 'search_available_slots') ? 'searched again in the same turn' : 'did not search again in that turn'}\n`);
  }, 300_000);

  it('replays reasoning items (encrypted_content) across tool rounds with store:false at reasoning effort low', async () => {
    const m = await connect();
    const call = await startCall(m, { MUJEEB_LLM_REASONING_EFFORT: 'low' });
    const child = m.dataset.patients.find((p) => p.key === 'patient-child');
    if (!child) throw new Error('dataset patient missing');
    await call.until((r) => has(r, 'list_patient_appointments', 'ok'), [
      `أبي أعرف موعد بنتي. جوالي ${child.phone.replace('+966', '0')} وتاريخ ميلادها تسعة مايو ألفين وعشرين`,
      'وش موعدها؟',
    ]);
    const toolRounds = call.model.rounds.filter((r) => r.calls.length > 0);
    expect(toolRounds.length).toBeGreaterThanOrEqual(2);
    process.stdout.write(`\n[live-llm] effort=low tool-round items: ${toolRounds.map((r) => `[${r.items.join(',')}]`).join(' ')}\n`);
    expect(toolRounds.flatMap((r) => r.items)).toContain('reasoning+enc');
  }, 300_000);
});
