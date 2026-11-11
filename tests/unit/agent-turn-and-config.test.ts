import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FakeLanguageModel } from '../../src/adapters/fakes/fake-llm.js';
import { type AgentOutput, type AgentToolbox, AgentTurn } from '../../src/agent/agent-turn.js';
import { Conversation } from '../../src/agent/conversation.js';
import type { ToolTurnContext } from '../../src/agent/tools/appointment-tools.js';
import { WaitPhrasePicker } from '../../src/agent/wait-phrases.js';
import { loadAgentProfile } from '../../src/app/agent-profile.js';
import { applyProfileVoice, createProviders } from '../../src/app/container.js';
import { loadSettings } from '../../src/config/settings.js';
import { CancelledError, ConfigError } from '../../src/core/errors.js';
import { CHUNK_FLUSH, chunkText } from '../../src/voice/text-chunker.js';

/** A toolbox double that records calls and can hold a tool open until released. */
function toolbox(options?: { holdMs?: number }) {
  const executed: { name: string; aborted: boolean }[] = [];
  const box: AgentToolbox = {
    definitions: () => [{ name: 'read', description: 'r', parameters: {} }, { name: 'write', description: 'w', parameters: {} }],
    mutates: (name) => name === 'write',
    contextNote: () => 'الآن: اختبار',
    async execute(name: string, _args: string, turn: ToolTurnContext) {
      await new Promise((r) => setTimeout(r, options?.holdMs ?? 0));
      executed.push({ name, aborted: turn.signal.aborted });
      return { output: { status: 'ok', name }, outcome: 'ok' };
    },
    onTurnFinalized: () => {},
    reconcileUnresolved: () => Promise.resolve([]),
    drain: () => Promise.resolve(0),
  };
  return { box, executed };
}

async function drainOutput(agent: AgentTurn): Promise<AgentOutput[]> {
  const out: AgentOutput[] = [];
  try {
    for await (const o of agent.output) out.push(o);
  } catch {
    /* cancelled turns fail the output stream */
  }
  return out;
}

const base = (llm: FakeLanguageModel, box: AgentToolbox, signal: AbortSignal) => ({
  llm,
  conversation: new Conversation({ instructions: 'i', maxTurns: 5 }),
  tools: box,
  userText: 'سؤال',
  userTurn: 1,
  turnId: 't1',
  signal,
  maxToolRounds: 3,
  firstEventTimeoutMs: 1000,
  mutationGraceMs: 0,
});

describe('AgentTurn', () => {
  it('streams text, signals a pause before tools, and records each round with its result', async () => {
    const llm = new FakeLanguageModel({ firstTokenDelayMs: 0, tokenDelayMs: 0, script: (_r, round) => (round === 0 ? { text: 'لحظة ', toolCalls: [{ name: 'read', arguments: {} }] } : { text: 'تمام' }) });
    const { box } = toolbox();
    const agent = new AgentTurn(base(llm, box, new AbortController().signal));
    expect(await drainOutput(agent)).toEqual([{ type: 'text', text: 'لحظة ' }, { type: 'pause' }, { type: 'text', text: 'تمام' }]);
    await agent.done;
    expect(agent.exchanges).toHaveLength(1);
    expect(agent.exchanges[0]?.continuation).toBeDefined();
    expect(agent).toMatchObject({ rounds: 2, sideEffects: false });
    expect(llm.calls[0]?.instructions).toBe('i\n\nالآن: اختبار');
  });

  it('lets a started write finish and records it after the turn is cancelled, but starts nothing new', async () => {
    const llm = new FakeLanguageModel({
      firstTokenDelayMs: 0,
      tokenDelayMs: 0,
      script: (_r, round) => (round === 0 ? { toolCalls: [{ name: 'write', arguments: {} }] } : { toolCalls: [{ name: 'read', arguments: {} }] }),
    });
    const { box, executed } = toolbox({ holdMs: 60 });
    const controller = new AbortController();
    const agent = new AgentTurn(base(llm, box, controller.signal));
    void drainOutput(agent);
    setTimeout(() => controller.abort(new CancelledError('barge_in')), 20);
    await agent.done;
    expect(executed).toEqual([{ name: 'write', aborted: true }]);
    expect(agent.exchanges.map((e) => e.calls[0]?.name)).toEqual(['write']);
    expect(agent.sideEffects).toBe(true);
    expect(llm.calls).toHaveLength(1);
  });

  it('never starts a write whose grace period is cut short by cancellation', async () => {
    const llm = new FakeLanguageModel({ firstTokenDelayMs: 0, tokenDelayMs: 0, script: () => ({ toolCalls: [{ name: 'write', arguments: {} }] }) });
    const { box, executed } = toolbox();
    const controller = new AbortController();
    const agent = new AgentTurn({ ...base(llm, box, controller.signal), mutationGraceMs: 200 });
    void drainOutput(agent);
    setTimeout(() => controller.abort(new CancelledError('user_continued')), 30);
    await agent.done;
    expect(executed).toEqual([]);
    expect(agent.sideEffects).toBe(false);
    expect(agent.exchanges).toEqual([]);
  });

  it('says the wait phrase once: a later round that opens with it again does not repeat it (observed live)', async () => {
    const phrase = 'لحظة أشيك لك.';
    const spoken = async (firstRoundText: string | undefined, secondRoundText: string): Promise<string> => {
      const llm = new FakeLanguageModel({
        firstTokenDelayMs: 0,
        tokenDelayMs: 0,
        script: (_r, round) => (round === 0 ? { ...(firstRoundText !== undefined ? { text: firstRoundText } : {}), toolCalls: [{ name: 'read', arguments: {} }] } : { text: secondRoundText }),
      });
      const agent = new AgentTurn({ ...base(llm, toolbox().box, new AbortController().signal), waitPhrases: new WaitPhrasePicker([phrase]) });
      return (await drainOutput(agent)).map((o) => (o.type === 'text' ? o.text : ' | ')).join('');
    };
    const times = (text: string): number => text.split(phrase).length - 1;

    const afterSystem = await spoken(undefined, 'لحظة أشيك لك. عندي ثلاث أوقات.'); // the system said it; the model repeats it
    expect(times(afterSystem)).toBe(1);
    expect(afterSystem).toContain('عندي ثلاث أوقات.');
    const afterModel = await spoken('لحظة أشيك لك.', 'لحظة أشيك لك. عندي ثلاث أوقات.'); // the model said it, then again
    expect(times(afterModel)).toBe(1);
    expect(afterModel).toContain('عندي ثلاث أوقات.');
    // Words that only start the same way are kept as they are.
    expect(await spoken(undefined, 'لحظة واحدة، عندي ثلاث أوقات.')).toContain('لحظة واحدة، عندي ثلاث أوقات.');
  });

  it('drops the repeated wait phrase however the model spells it, but only as whole words', async () => {
    const phrase = 'لحظه أشيّك لك.'; // spelled for TTS; the model tends to write "لحظة أشيك لك."
    const spoken = async (firstRoundText: string | undefined, secondRoundText: string): Promise<string> => {
      const llm = new FakeLanguageModel({
        firstTokenDelayMs: 0,
        tokenDelayMs: 0,
        script: (_r, round) => (round === 0 ? { ...(firstRoundText !== undefined ? { text: firstRoundText } : {}), toolCalls: [{ name: 'read', arguments: {} }] } : { text: secondRoundText }),
      });
      const agent = new AgentTurn({ ...base(llm, toolbox().box, new AbortController().signal), waitPhrases: new WaitPhrasePicker([phrase]) });
      return (await drainOutput(agent)).map((o) => (o.type === 'text' ? o.text : ' | ')).join('');
    };

    expect(await spoken(undefined, 'لحظة أشيك لك. عندي ثلاث أوقات.')).toBe('لحظه أشيّك لك. | عندي ثلاث أوقات.');
    expect(await spoken(undefined, 'لحظة، أشيك لك عندي ثلاث أوقات.')).toBe('لحظه أشيّك لك. | عندي ثلاث أوقات.');
    expect(await spoken(undefined, 'لحظة أشيك لك')).toBe('لحظه أشيّك لك. | '); // the whole round was the repeat
    // The model said it first (its own spelling), then again in the next round.
    expect(await spoken('لحظة أشيك لك.', 'لحظه أشيّك لك. عندي ثلاث أوقات.')).toBe('لحظة أشيك لك. | عندي ثلاث أوقات.');
    // "لكم" is not "لك": the words are kept.
    expect(await spoken(undefined, 'لحظة أشيك لكم المواعيد.')).toBe('لحظه أشيّك لك. | لحظة أشيك لكم المواعيد.');
  });

  it('with several wait phrases: says the picked one, and drops any of them the model opens the next round with', async () => {
    const phrases = ['ثواني بس.', 'خلني أشوف لك.', 'لحظه أشيّك لك.'];
    const run = async (picker: WaitPhrasePicker, firstRoundText: string | undefined, secondRoundText: string): Promise<string> => {
      const llm = new FakeLanguageModel({
        firstTokenDelayMs: 0,
        tokenDelayMs: 0,
        script: (_r, round) => (round === 0 ? { ...(firstRoundText !== undefined ? { text: firstRoundText } : {}), toolCalls: [{ name: 'read', arguments: {} }] } : { text: secondRoundText }),
      });
      const agent = new AgentTurn({ ...base(llm, toolbox().box, new AbortController().signal), waitPhrases: picker });
      return (await drainOutput(agent)).map((o) => (o.type === 'text' ? o.text : ' | ')).join('');
    };
    const picks: string[] = [];
    const picker = new WaitPhrasePicker(phrases, { random: () => 0, onPick: () => picks.push('pick') });
    // The system says one phrase; the model then opens with a different one of the list: a second filler, dropped.
    const first = await run(picker, undefined, 'لحظة أشيك لك. عندي ثلاث أوقات.');
    expect(first.endsWith(' | عندي ثلاث أوقات.')).toBe(true);
    expect(phrases.filter((p) => first.includes(p))).toHaveLength(1);
    // The model spoke first: no phrase is said, and none is used up.
    expect(await run(picker, 'أبشر.', 'عندي ثلاث أوقات.')).toBe('أبشر. | عندي ثلاث أوقات.');
    expect(picks).toHaveLength(1);
    // Turns of one call hear different phrases.
    const second = await run(picker, undefined, 'تمام.');
    const third = await run(picker, undefined, 'تمام.');
    const said = [first, second, third].map((text) => phrases.find((p) => text.startsWith(p)));
    expect(new Set(said).size).toBe(3);
  });
});

describe('wait phrase picker', () => {
  it('says every phrase once before any repeats, and never the same phrase twice in a row', () => {
    const phrases = ['أ', 'ب', 'ج', 'د'];
    let seed = 7;
    const random = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    const picker = new WaitPhrasePicker(phrases, { random });
    const said = Array.from({ length: 40 }, () => picker.next());
    for (let i = 0; i < said.length; i += phrases.length) expect(new Set(said.slice(i, i + phrases.length)).size).toBe(phrases.length);
    for (let i = 1; i < said.length; i += 1) expect(said[i], `pick ${i}`).not.toBe(said[i - 1]);
  });

  it('a phrase that ends one bag is never the first of the next, even when the shuffle puts it there', () => {
    // Two phrases, one random() per refill: 0.9999 keeps [a, b] (b leaves first, a last); 0 swaps to [b, a],
    // which would make "a" leave first again right after it left last.
    const draws = [0.9999, 0, 0.9999, 0];
    const picker = new WaitPhrasePicker(['a', 'b'], { random: () => draws.shift() ?? 0 });
    const said = Array.from({ length: 8 }, () => picker.next());
    expect(said.slice(0, 2)).toEqual(['b', 'a']);
    for (let i = 1; i < said.length; i += 1) expect(said[i], `pick ${i}`).not.toBe(said[i - 1]);
  });

  it('one phrase is fine (always that one); duplicates count once; an empty list is refused', () => {
    expect([1, 2, 3].map(() => new WaitPhrasePicker(['لحظة.']).next())).toEqual(['لحظة.', 'لحظة.', 'لحظة.']);
    expect(new WaitPhrasePicker(['أ', ' أ ', 'ب']).all).toEqual(['أ', 'ب']);
    expect(() => new WaitPhrasePicker([' '])).toThrow();
  });
});

describe('text chunker flush', () => {
  it('emits held text immediately on a flush marker, even when short or unpunctuated', async () => {
    async function* source() {
      await Promise.resolve();
      yield 'لحظة';
      yield CHUNK_FLUSH;
      yield 'عندنا الدكتورة سارة يوم الخميس الساعة عشر الصبح. ';
    }
    const out: string[] = [];
    for await (const piece of chunkText(source())) out.push(piece);
    expect(out).toEqual(['لحظة', 'عندنا الدكتورة سارة يوم الخميس الساعة عشر الصبح.']);
  });
});

describe('Phase 1 configuration', () => {
  it('defaults: in-memory scheduling, a larger output budget for tool rounds, assistant phase on', () => {
    const s = loadSettings({}, { forceFakeProviders: true });
    expect(s.scheduling).toEqual({ provider: 'memory', datasetPath: 'config/test-data/demo-clinic.dataset.json', readTimeoutMs: 4000, writeTimeoutMs: 8000 });
    expect(s.llm).toMatchObject({ maxOutputTokensWithTools: 1024, assistantPhase: true });
    expect(s.voice.toolConfirmGraceMs).toBe(400);
    const off = loadSettings({ MUJEEB_SCHEDULING_PROVIDER: 'none', MUJEEB_LLM_ASSISTANT_PHASE: 'false' }, { forceFakeProviders: true });
    expect(off.scheduling.provider).toBe('none');
    expect(off.llm.assistantPhase).toBe(false);
    expect(() => loadSettings({ MUJEEB_SCHEDULING_PROVIDER: 'medplum' }, { forceFakeProviders: true })).toThrow(/MUJEEB_SCHEDULING_PROVIDER/);
  });

  it('loads the demo profile with its tool rules and development-only verification', async () => {
    const profile = await loadAgentProfile('config/agents/demo-clinic');
    expect(profile.timezone).toBe('Asia/Riyadh');
    expect(profile.appointmentTools).toMatchObject({ patientVerification: 'dev-identifier-dob', maxToolRounds: 5, pendingActionTtlSec: 120, maxReconfirmations: 2 });
    expect(profile.appointmentTools?.instructions).toContain('confirm_pending_action');
    expect(profile.instructions).not.toContain('لا تقدر في هذه المرحلة تحجز');
  });

  it('rejects tool settings without a time zone, unknown verification policies, and files outside the profile', async () => {
    const write = (profile: Record<string, unknown>) => {
      const dir = mkdtempSync(join(tmpdir(), 'mujeeb-profile-'));
      writeFileSync(join(dir, 'instructions.md'), 'x');
      writeFileSync(join(dir, 'tools.md'), 'y');
      writeFileSync(join(dir, 'profile.json'), JSON.stringify({ tenantId: 't', agentId: 'a', displayName: 'd', languageCode: 'ar', instructionsFile: 'instructions.md', ...profile }));
      return dir;
    };
    const tools = { instructionsFile: 'tools.md', patientVerification: 'dev-identifier-dob' };
    await expect(loadAgentProfile(write({ appointmentTools: tools }))).rejects.toThrow(/timezone/);
    await expect(loadAgentProfile(write({ timezone: 'Asia/Riyadh', appointmentTools: { ...tools, patientVerification: 'otp' } }))).rejects.toBeInstanceOf(ConfigError);
    await expect(loadAgentProfile(write({ timezone: 'Asia/Riyadh', appointmentTools: { ...tools, instructionsFile: '../tools.md' } }))).rejects.toThrow(/inside the profile directory/);
    expect((await loadAgentProfile(write({ timezone: 'Asia/Riyadh', appointmentTools: tools }))).appointmentTools?.instructions).toBe('y');
    expect((await loadAgentProfile(write({ voiceId: 'clinic-voice' }))).voiceId).toBe('clinic-voice');
    await expect(loadAgentProfile(write({ voiceId: ' ' }))).rejects.toThrow(/voiceId/);
  });

  it('wait phrases: a list, or the older single phrase (loaded as a one-phrase list), not both', async () => {
    const write = (tools: Record<string, unknown>) => {
      const dir = mkdtempSync(join(tmpdir(), 'mujeeb-profile-'));
      writeFileSync(join(dir, 'instructions.md'), 'x');
      writeFileSync(join(dir, 'tools.md'), 'y');
      const appointmentTools = { instructionsFile: 'tools.md', patientVerification: 'dev-identifier-dob', ...tools };
      writeFileSync(join(dir, 'profile.json'), JSON.stringify({ tenantId: 't', agentId: 'a', displayName: 'd', languageCode: 'ar', instructionsFile: 'instructions.md', timezone: 'Asia/Riyadh', appointmentTools }));
      return dir;
    };
    expect((await loadAgentProfile(write({ waitPhrases: ['ثواني بس.', 'خلني أشوف لك.'] }))).appointmentTools?.waitPhrases).toEqual(['ثواني بس.', 'خلني أشوف لك.']);
    const older = (await loadAgentProfile(write({ waitPhrase: 'لحظه أشيّك لك.' }))).appointmentTools;
    expect(older?.waitPhrases).toEqual(['لحظه أشيّك لك.']);
    expect(older).not.toHaveProperty('waitPhrase');
    expect((await loadAgentProfile(write({}))).appointmentTools).not.toHaveProperty('waitPhrases');
    await expect(loadAgentProfile(write({ waitPhrase: 'أ', waitPhrases: ['ب'] }))).rejects.toThrow(/waitPhrases/);
    await expect(loadAgentProfile(write({ waitPhrases: [] }))).rejects.toBeInstanceOf(ConfigError);
    await expect(loadAgentProfile(write({ waitPhrases: ['x'.repeat(61)] }))).rejects.toBeInstanceOf(ConfigError);
  });

  it('phone words: the silence check and its goodbye go together; the length-limit goodbye is optional', async () => {
    const write = (phone: Record<string, unknown>) => {
      const dir = mkdtempSync(join(tmpdir(), 'mujeeb-profile-'));
      writeFileSync(join(dir, 'instructions.md'), 'x');
      writeFileSync(join(dir, 'profile.json'), JSON.stringify({ tenantId: 't', agentId: 'a', displayName: 'd', languageCode: 'ar', instructionsFile: 'instructions.md', phone }));
      return dir;
    };
    const both = { silencePromptText: 'ألو؟', silenceGoodbyeText: 'مع السلامة.' };
    expect((await loadAgentProfile(write(both))).phone).toEqual(both);
    expect((await loadAgentProfile(write({ maxDurationGoodbyeText: 'مع السلامة.' }))).phone).toEqual({ maxDurationGoodbyeText: 'مع السلامة.' });
    await expect(loadAgentProfile(write({ silencePromptText: 'ألو؟' }))).rejects.toThrow(/silenceGoodbyeText/);
    await expect(loadAgentProfile(write({ ...both, silencePromptText: ' ' }))).rejects.toBeInstanceOf(ConfigError);
  });

  it('phone call settings: check after 10 s of silence, hang up 5 s later, at most 10 minutes; 0 turns each off', () => {
    expect(loadSettings({}, { forceFakeProviders: true }).voice).toMatchObject({ silencePromptMs: 10_000, silenceHangupMs: 5000, maxCallMs: 600_000 });
    expect(loadSettings({ MUJEEB_SILENCE_PROMPT_MS: '0', MUJEEB_CALL_MAX_MS: '0' }, { forceFakeProviders: true }).voice).toMatchObject({ silencePromptMs: 0, maxCallMs: 0 });
    expect(() => loadSettings({ MUJEEB_SILENCE_HANGUP_MS: '0' }, { forceFakeProviders: true })).toThrow(/MUJEEB_SILENCE_HANGUP_MS/);
  });

  it('a stuck STT partial is answered after 3 s by default (above the 2.7 s longest normal commit); 0 turns it off', () => {
    expect(loadSettings({}, { forceFakeProviders: true }).voice.stalePartialCommitMs).toBe(3000);
    expect(loadSettings({ MUJEEB_STT_STALE_PARTIAL_MS: '0' }, { forceFakeProviders: true }).voice.stalePartialCommitMs).toBe(0);
  });
});

describe('clinic voice', () => {
  const env = (voice?: string) =>
    loadSettings({
      ELEVENLABS_API_KEY: 'k',
      MUJEEB_LLM_PROVIDER: 'fake',
      MUJEEB_STT_PROVIDER: 'fake',
      MUJEEB_TTS_MODEL: 'tts-model',
      ...(voice !== undefined ? { MUJEEB_TTS_VOICE_ID: voice } : {}),
    });

  it('uses the clinic profile voice over the environment default', () => {
    expect(applyProfileVoice(env('env-voice'), { voiceId: 'clinic-voice' }).tts.voiceId).toBe('clinic-voice');
    expect(applyProfileVoice(env(), { voiceId: 'clinic-voice' }).tts.voiceId).toBe('clinic-voice');
  });

  it('falls back to MUJEEB_TTS_VOICE_ID when the profile names no voice', () => {
    const settings = applyProfileVoice(env('env-voice'), {});
    expect(settings.tts.voiceId).toBe('env-voice');
    expect(() => createProviders(settings)).not.toThrow();
  });

  it('refuses to start without a voice in either place, and says where to set one', () => {
    expect(() => createProviders(applyProfileVoice(env(), {}))).toThrow(ConfigError);
    expect(() => createProviders(applyProfileVoice(env(), {}))).toThrow(/profile\.json.*MUJEEB_TTS_VOICE_ID/);
  });
});
