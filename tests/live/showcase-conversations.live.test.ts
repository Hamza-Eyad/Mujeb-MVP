import { describe, expect, it } from 'vitest';
import { MemorySchedulingSystem } from '../../src/adapters/fakes/memory-scheduling.js';
import { type AgentToolbox, AgentTurn } from '../../src/agent/agent-turn.js';
import { Conversation } from '../../src/agent/conversation.js';
import { AppointmentTools, type ToolCallResult, type ToolTurnContext } from '../../src/agent/tools/appointment-tools.js';
import { loadAgentProfile } from '../../src/app/agent-profile.js';
import { createProviders } from '../../src/app/container.js';
import { loadSchedulingDataset } from '../../src/app/scheduling-dataset.js';
import { loadSettings } from '../../src/config/settings.js';
import { silentLogger } from '../../src/core/logger.js';
import type { LanguageModel, LlmEvent, LlmRequest } from '../../src/ports/language-model.js';

/**
 * The showcase clinic (config/agents/showcase-clinic) answering natural Saudi caller turns: the real language model
 * and the real appointment tools on the in-memory synthetic dataset. No audio, no phone, no Medplum. It checks what
 * a manager demo needs: clinic questions answered from the profile, the directory listed, a booking completed only
 * after the caller says yes, and never a "demo version" refusal. Paid (OpenAI only) and opt-in:
 *
 *   MUJEEB_LIVE_SHOWCASE=1 npx vitest run --config vitest.live.config.ts tests/live/showcase-conversations.live.test.ts
 *
 * MAX_REQUESTS caps the model requests of one run: the run fails, rather than spends, past it.
 */

const env = process.env;
const ENABLED = env['MUJEEB_LIVE_SHOWCASE'] === '1' && Boolean(env['OPENAI_API_KEY'] && env['MUJEEB_LLM_MODEL']);
const PROFILE = 'config/agents/showcase-clinic';
const MAX_REQUESTS = Number(env['MUJEEB_LIVE_SHOWCASE_MAX_REQUESTS'] ?? 40);

let requests = 0;

/** Counts model requests across the whole run and refuses one past the cap. */
class CappedModel implements LanguageModel {
  readonly name: string;
  constructor(private readonly inner: LanguageModel) {
    this.name = inner.name;
  }
  async *stream(request: LlmRequest, options: { signal: AbortSignal }): AsyncGenerator<LlmEvent> {
    if (requests >= MAX_REQUESTS) throw new Error(`request cap reached (${MAX_REQUESTS}): stopping before spending more`);
    requests += 1;
    yield* this.inner.stream(request, options);
  }
}

interface ToolRecord {
  name: string;
  outcome: string;
  output: Record<string, unknown>;
}

class RecordingToolbox implements AgentToolbox {
  calls: ToolRecord[] = [];
  constructor(private readonly inner: AppointmentTools) {}
  definitions() {
    return this.inner.definitions();
  }
  async execute(name: string, rawArguments: string, turn: ToolTurnContext): Promise<ToolCallResult> {
    const result = await this.inner.execute(name, rawArguments, turn);
    this.calls.push({ name, outcome: result.outcome, output: result.output });
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

interface Turn {
  user: string;
  reply: string;
  tools: ToolRecord[];
}

let callSeq = 0;
async function startCall() {
  const settings = loadSettings({
    ...env,
    MUJEEB_STT_PROVIDER: 'fake',
    MUJEEB_TTS_PROVIDER: 'fake',
    MUJEEB_SCHEDULING_PROVIDER: 'memory',
    MUJEEB_AGENT_PROFILE: PROFILE,
  });
  const profile = await loadAgentProfile(settings.agentProfilePath);
  const toolsProfile = profile.appointmentTools;
  if (!toolsProfile || profile.timezone === undefined || profile.schedulingDataset === undefined) throw new Error('showcase profile incomplete');
  const tenant = { tenantId: profile.tenantId, agentId: profile.agentId };
  const scheduling = new MemorySchedulingSystem({ tenantId: tenant.tenantId, dataset: await loadSchedulingDataset(profile.schedulingDataset) });
  const model = new CappedModel(createProviders(settings).llm);
  callSeq += 1;
  const tools = new RecordingToolbox(
    new AppointmentTools({
      scheduling,
      tenant,
      sessionId: `ses_live_showcase_${Date.now()}_${callSeq}`,
      timeZone: profile.timezone,
      log: silentLogger,
      verificationPolicy: toolsProfile.patientVerification,
      pendingActionTtlMs: toolsProfile.pendingActionTtlSec * 1000,
      maxReconfirmations: toolsProfile.maxReconfirmations,
    }),
  );
  const conversation = new Conversation({ instructions: `${profile.instructions}\n\n${toolsProfile.instructions}`, maxTurns: profile.historyMaxTurns });
  if (profile.greeting) conversation.addAssistant(profile.greeting);
  let userTurn = 0;

  const say = async (text: string): Promise<Turn> => {
    userTurn += 1;
    const turnId = `show${callSeq}-t${userTurn}`;
    tools.calls = [];
    const agent = new AgentTurn({
      llm: model,
      conversation,
      tools,
      userText: text,
      userTurn,
      turnId,
      signal: AbortSignal.timeout(90_000),
      maxToolRounds: toolsProfile.maxToolRounds,
      firstEventTimeoutMs: settings.llm.firstTokenTimeoutMs,
      mutationGraceMs: 0,
      notes: [],
    });
    let reply = '';
    for await (const out of agent.output) reply += out.type === 'text' ? out.text : ' ';
    await agent.done;
    conversation.commitTurn({ user: text, exchanges: agent.exchanges, assistant: reply });
    tools.onTurnFinalized(turnId, true, reply);
    const turn: Turn = { user: text, reply: reply.trim(), tools: tools.calls };
    process.stdout.write(
      `\n[showcase] ${turnId}  caller: ${text}\n  tools: ${turn.tools.map((c) => `${c.name}→${c.outcome}`).join(', ') || '-'}\n  mujeeb: ${turn.reply}\n  [requests so far: ${requests}/${MAX_REQUESTS}]\n`,
    );
    expectSpeakable(turn);
    return turn;
  };
  return { say };
}

/** Every reply: no "demo/test" refusal, and no digits (the voice reads them badly). */
function expectSpeakable(t: Turn): void {
  expect(t.reply, 'never calls itself a demo or a test').not.toMatch(/تجريبي|تجريبية|اختبار/);
  expect(t.reply, 'numbers are written as words').not.toMatch(/[0-9٠-٩]/);
  expect(t.reply.length).toBeGreaterThan(0);
}

const used = (t: Turn, name: string, outcome?: string) => t.tools.some((c) => c.name === name && (outcome === undefined || c.outcome === outcome));
const mentions = (t: Turn, words: string[]) => words.filter((w) => t.reply.includes(w)).length;

describe.skipIf(!ENABLED)('live: the showcase clinic answers a manager demo', () => {
  it('lists the clinics, also when STT turns "وش" into "وسع"', async () => {
    const specialties = ['الأسرة', 'الباطنية', 'الأطفال', 'الجلدية', 'الأسنان', 'العيون', 'النساء', 'العظام'];
    const a = await (await startCall()).say('وش العيادات اللي عندكم؟');
    expect(mentions(a, specialties)).toBeGreaterThanOrEqual(5);
    const b = await (await startCall()).say('وسع العيادات المتوفرة عندكم');
    expect(mentions(b, specialties)).toBeGreaterThanOrEqual(5);
  });

  it('answers clinic questions from the profile: hours, location, insurance, price', async () => {
    const call = await startCall();
    expect((await call.say('كم الدوام عندكم؟')).reply).toMatch(/السبت|الخميس/);
    expect((await call.say('طيب وين مكانكم؟')).reply).toMatch(/الياسمين|الرياض/);
    expect((await call.say('تقبلون التأمين؟')).reply).toMatch(/تأمين|التأمين/);
    expect((await call.say('بكم الكشف عند الجلدية؟')).reply).toMatch(/ميتين/);
  });

  it('says what it does not have, and offers what it does, without refusing', async () => {
    const heart = await (await startCall()).say('عندكم عيادة قلب؟');
    expect(heart.reply).not.toMatch(/^نعم|^إيه عندنا/);
    const cafe = await (await startCall()).say('عندكم كافتيريا في المجمع؟');
    expect(cafe.tools.some((c) => c.name.startsWith('propose_'))).toBe(false);
  });

  it('finds times for dermatology straight away, and for a doctor by name', async () => {
    const derm = await (await startCall()).say('أبي أحجز موعد بعيادة الجلدية');
    expect(used(derm, 'search_available_slots')).toBe(true);
    expect(derm.reply).toMatch(/الدّكتور|الدكتور|الدّكتورة|الدكتورة/);
    const sara = await (await startCall()).say('أبي موعد عند الدكتورة سارة');
    expect(used(sara, 'search_available_slots')).toBe(true);
  });

  it('books end to end: times, identity, read-back, and only then the booking', async () => {
    const call = await startCall();
    const times = await call.say('السلام عليكم، أبي أحجز موعد أسنان');
    expect(used(times, 'search_available_slots')).toBe(true);
    const pick = await call.say('أول وقت يناسبني');
    let proposal = used(pick, 'propose_booking', 'confirmation_required') ? pick : undefined;
    if (!proposal) {
      const id = await call.say('رقم هويتي واحد صفر صفر صفر صفر صفر صفر خمسة صفر صفر، وتاريخ ميلادي خمسة وعشرين واحد ألف وتسعمية وثمانية وسبعين');
      expect(used(id, 'find_patient', 'verified')).toBe(true);
      proposal = used(id, 'propose_booking', 'confirmation_required') ? id : await call.say('إيه نفس الوقت الأول');
    }
    expect(used(proposal, 'propose_booking', 'confirmation_required')).toBe(true);
    expect(used(proposal, 'confirm_pending_action')).toBe(false);
    const done = await call.say('إيه أكّد');
    const confirm = done.tools.find((c) => c.name === 'confirm_pending_action');
    expect(confirm?.output['status']).toBe('done');
  });

  it.each([
    ['ظهري يعورني من أسبوع، أبي أحجز', ['العظام']],
    ['أسناني توجعني', ['الأسنان']],
    ['أبي حشو', ['الأسنان']],
    ['عندي حرارة وسخونة من أمس', ['طب الأسرة', 'الباطنية']],
    ['ولدي عمره خمس سنين وحرارته مرتفعة', ['طب الأطفال']],
    ['بطني يعورني من أمس', ['الباطنية', 'طب الأسرة']],
  ])('routes a need to the fitting clinic by understanding, not a word list: "%s"', async (utterance, fitting) => {
    const t = await (await startCall()).say(utterance);
    // Where it went = the clinic of the free times it looked up (or, without a lookup, the clinic it named).
    const searched = t.tools
      .filter((c) => c.name === 'search_available_slots')
      .flatMap((c) => ((c.output['slots'] as { service?: string }[] | undefined) ?? []).map((s) => s.service ?? ''));
    const routed = searched.length > 0 ? searched : fitting.filter((f) => t.reply.includes(f.replace(/^طب /, '')));
    expect(routed.length, 'routed somewhere').toBeGreaterThan(0);
    for (const service of routed) expect(fitting).toContain(service);
    expect(t.tools.some((c) => c.name.startsWith('propose_'))).toBe(false);
  });

  it('sends a likely emergency to the ambulance or the ER instead of booking', async () => {
    const t = await (await startCall()).say('صدري يوجعني مرة وما أقدر أتنفس زين');
    expect(t.reply).toMatch(/الإسعاف|الطّوارئ|الطوارئ|تسعة تسعة سبعة/);
    expect(t.tools.some((c) => c.name.startsWith('propose_') || c.name === 'search_available_slots')).toBe(false);
  });

  it('registers a new caller with what they already said, asks only for the rest, then books the time they chose', async () => {
    const call = await startCall();
    expect(used(await call.say('أبي موعد أسنان'), 'search_available_slots')).toBe(true);
    await call.say('أول وقت يناسبني');
    // Identity that matches no file (owner's live call, 2026-11-09).
    const failed = await call.say('رقم هويتي واحد واحد ثنين ثنين ثلاثة ثلاثة أربعة أربعة خمسة خمسة، وتاريخ ميلادي خمسطعش ثلاثة ألفين وثنين');
    expect(used(failed, 'find_patient', 'not_verified')).toBe(true);
    expect(failed.reply, 'offers a file, in the clinic wording').not.toMatch(/مريض جديد|أسجلك|أرسل/);
    const ask = await call.say('إيه افتح لي ملف'); // the owner's words on the phone
    expect(ask.reply, 'asks for what is missing (the name)').toMatch(/اسم/);
    expect(ask.reply, 'does not ask again for the ID or the date of birth').not.toMatch(/تاريخ ميلادك|تاريخ الميلاد|رقم هويتك|رقم الهوية/);
    expect(ask.reply).not.toMatch(/مريض جديد|أسجلك/);
    const proposed = await call.say('اسمي ريان سعيد الشمري، وجوالي صفر خمسة صفر صفر صفر صفر صفر واحد صفر سبعة');
    const registration = proposed.tools.find((c) => c.name === 'propose_registration' && c.outcome === 'confirmation_required');
    expect(registration, 'registration proposed without asking the ID or the date again').toBeDefined();
    expect(registration?.output['read_back']).toMatchObject({ national_id: '1122334455', birth_date: '2002-03-15' });
    const opened = await call.say('إيه افتح الملف');
    expect(opened.tools.find((c) => c.name === 'confirm_pending_action')?.output['status']).toBe('done');
    // The turn ends on the system's words; the booking the caller came for continues with their next word.
    expect(opened.reply).toMatch(/أكمل لك حجز الموعد/);
    const booking = await call.say('إيه');
    expect(used(booking, 'propose_booking', 'confirmation_required'), 'continues to the booking without asking anything else').toBe(true);
  });

  it('opens a file for a caller who gave the phone first: asks only for the name and the ID', async () => {
    const call = await startCall();
    await call.say('أبي موعد أسنان');
    await call.say('الأول');
    const failed = await call.say('رقم جوالي صفر خمسة صفر صفر صفر صفر صفر واحد صفر تسعة، وتاريخ ميلادي ثلاثة أبريل ألف وتسعمية وخمسة وتسعين');
    expect(used(failed, 'find_patient', 'not_verified')).toBe(true);
    const ask = await call.say('ما عندي ملف، افتح لي ملف');
    expect(ask.reply, 'asks for the ID').toMatch(/هوية|الهوية/);
    expect(ask.reply, 'does not ask again for the phone or the date of birth').not.toMatch(/تاريخ ميلادك|تاريخ الميلاد|رقم جوالك|رقم الجوال/);
    expect(ask.reply).not.toMatch(/مريض جديد|أسجلك/);
  });

  it('reads a date the STT glued together, and confirms its best guess instead of asking again', async () => {
    const call = await startCall();
    expect(used(await call.say('أبي موعد عيون'), 'search_available_slots')).toBe(true);
    await call.say('الأول');
    // 25/1/1978 as the STT may write it, with the existing patient's phone.
    const id = await call.say('رقم الجوال 0500000105 وتاريخ الميلاد 2511978');
    const verified = used(id, 'find_patient', 'verified') || (id.reply.includes('يناير') && used(await call.say('إيه صح'), 'find_patient', 'verified'));
    expect(verified, 'verified with 25 January 1978, at most after one yes').toBe(true);
  });

  it('turns broken date fragments from the owner\'s call into one clear question, never the same one again and again', async () => {
    const call = await startCall();
    await call.say('أبي موعد عيون');
    await call.say('الأول');
    await call.say('رقم الجوال 0505400500');
    const months = /يناير|فبراير|مارس|أبريل|ابريل|مايو|يونيو|يوليو|أغسطس|اغسطس|سبتمبر|أكتوبر|اكتوبر|نوفمبر|ديسمبر|الشهر/;
    const first = await call.say('11964.'); // heard on the phone, 2026-11-09
    expect(first.reply, 'a guess to confirm, or the month by name').toMatch(months);
    const second = await call.say('511. 1964.'); // heard on the phone: 5 November 1964
    expect(second.reply).toMatch(/نوفمبر/);
    expect(second.reply).not.toBe(first.reply);
  });

  it('does not diagnose or prescribe, and points to booking', async () => {
    const t = await (await startCall()).say('عندي صداع قوي من يومين، وش آخذ له دوا؟');
    expect(t.reply).not.toMatch(/بنادول|باراسيتامول|بروفين|ايبوبروفين|حبة|حبوب/);
    expect(t.tools.some((c) => c.name.startsWith('propose_'))).toBe(false);
  });
});
