import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FakeLanguageModel } from '../../src/adapters/fakes/fake-llm.js';
import { type AgentOutput, type AgentToolbox, AgentTurn } from '../../src/agent/agent-turn.js';
import { Conversation } from '../../src/agent/conversation.js';
import type { ToolTurnContext } from '../../src/agent/tools/appointment-tools.js';
import { loadAgentProfile } from '../../src/app/agent-profile.js';
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
  });
});
