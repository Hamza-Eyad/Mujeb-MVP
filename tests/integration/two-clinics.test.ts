import { afterEach, describe, expect, it } from 'vitest';
import { FakeLanguageModel } from '../../src/adapters/fakes/fake-llm.js';
import { FakeSpeechToText } from '../../src/adapters/fakes/fake-stt.js';
import { FakeTextToSpeech } from '../../src/adapters/fakes/fake-tts.js';
import { AppointmentTools } from '../../src/agent/tools/appointment-tools.js';
import { loadAgentProfile } from '../../src/app/agent-profile.js';
import { CallRouter } from '../../src/app/call-router.js';
import { applyProfileDataset, assertSchedulingServesOneTenant, createScheduling } from '../../src/app/container.js';
import type { AgentRuntime } from '../../src/app/session-factory.js';
import { type TelephonyServer, startTelephonyServer } from '../../src/app/telephony-server.js';
import { loadSettings } from '../../src/config/settings.js';
import type { AgentProfile } from '../../src/contracts/agent-profile.js';
import { ProviderError } from '../../src/core/errors.js';
import { silentLogger } from '../../src/core/logger.js';
import { MemoryTurnSink } from '../../src/observability/turn-metrics.js';
import type { SchedulingSystem } from '../../src/ports/scheduling.js';
import { type FakeAsterisk, connectFakeAsterisk } from '../support/fake-asterisk.js';
import { TEST_CONFIG, delay, frame, waitFor } from '../support/session-harness.js';

/**
 * Two synthetic clinics on one gateway (plans/2026-10-28-phase-4-step-2-lab.md, items 4 and 6): each clinic's
 * appointments, patients, refs and sessions stay its own. Built from the real profiles and datasets in
 * config/, with in-memory scheduling. This says nothing about isolation on Medplum (one sandbox project).
 */

const CLINIC_A = 'config/agents/demo-clinic';
const CLINIC_B = 'config/agents/demo-clinic-b';
const FAKES = { MUJEEB_STT_PROVIDER: 'fake', MUJEEB_LLM_PROVIDER: 'fake', MUJEEB_TTS_PROVIDER: 'fake', MUJEEB_SCHEDULING_PROVIDER: 'memory' };

interface Clinic {
  profile: AgentProfile;
  system: SchedulingSystem;
}

async function clinic(dir: string): Promise<Clinic> {
  const profile = await loadAgentProfile(dir);
  const system = await createScheduling(applyProfileDataset(loadSettings(FAKES), profile), profile.tenantId);
  if (!system) throw new Error('no scheduling system');
  return { profile, system };
}

/** One call's appointment tools, driven turn by turn as the voice session does. */
function call(c: Clinic, sessionId: string) {
  const tp = c.profile.appointmentTools;
  if (!tp || c.profile.timezone === undefined) throw new Error('profile without appointment tools');
  const tools = new AppointmentTools({
    scheduling: c.system,
    tenant: { tenantId: c.profile.tenantId, agentId: c.profile.agentId },
    sessionId,
    timeZone: c.profile.timezone,
    log: silentLogger,
    verificationPolicy: tp.patientVerification,
    pendingActionTtlMs: tp.pendingActionTtlSec * 1000,
    maxReconfirmations: tp.maxReconfirmations,
    readTimeoutMs: 4000,
    writeTimeoutMs: 8000,
  });
  let userTurn = 0;
  /** One caller turn with one tool call; the caller hears the whole reply (system read-back included). */
  return async (callerUtterance: string, name: string, args: Record<string, unknown>) => {
    userTurn += 1;
    const turnId = `${sessionId}-turn-${userTurn}`;
    const result = await tools.execute(name, JSON.stringify(args), { userTurn, callerUtterance, turnId, signal: AbortSignal.timeout(10_000) });
    tools.onTurnFinalized(turnId, true, result.speech ?? '');
    return result;
  };
}

const names = (output: Record<string, unknown>): unknown[] => ((output['results'] as Record<string, unknown>[] | undefined) ?? []).map((r) => r['name']);
const patientRef = (output: Record<string, unknown>): string => String((output['patient'] as Record<string, unknown> | undefined)?.['ref']);

describe('two clinics: data isolation through the appointment tools', () => {
  it('each clinic answers from its own directory and its own patients', async () => {
    const [a, b] = await Promise.all([clinic(CLINIC_A), clinic(CLINIC_B)]);
    const a1 = call(a, 'ses_a1');
    const b1 = call(b, 'ses_b1');

    const dentistry = { query: 'أسنان', kind: 'service', service_ref: null };
    const pediatrics = { query: 'أطفال', kind: 'service', service_ref: null };
    expect(names((await b1('عندكم أسنان؟', 'search_clinic_directory', dentistry)).output)).toContain('طب الأسنان');
    expect(names((await a1('عندكم أسنان؟', 'search_clinic_directory', dentistry)).output)).not.toContain('طب الأسنان');
    expect(names((await a1('عندكم أطفال؟', 'search_clinic_directory', pediatrics)).output)).toContain('طب الأطفال');
    expect(names((await b1('عندكم أطفال؟', 'search_clinic_directory', pediatrics)).output)).not.toContain('طب الأطفال');

    // Clinic A's patient (config/test-data/demo-clinic.dataset.json) and clinic B's.
    const patientOfA = { national_id: '1000000100', phone: null, birth_date: '1990-03-14' };
    const patientOfB = { national_id: '1000000600', phone: null, birth_date: '1988-04-10' };
    expect((await a1('رقمي', 'find_patient', patientOfA)).outcome).toBe('verified');
    expect((await b1('رقمي', 'find_patient', patientOfA)).outcome).toBe('not_verified');
    expect((await b1('رقمي', 'find_patient', patientOfB)).outcome).toBe('verified');
    expect((await call(a, 'ses_a2')('رقمي', 'find_patient', patientOfB)).outcome).toBe('not_verified');
  });

  it('a patient registered in one clinic does not exist in the other', async () => {
    const [a, b] = await Promise.all([clinic(CLINIC_A), clinic(CLINIC_B)]);
    const a1 = call(a, 'ses_a1');
    const newPatient = { full_name: 'مريض اختبار العزل', national_id: '1000000800', phone: '0500000299', birth_date: '1993-06-01', gender: 'male' };
    const proposed = await a1('أبي أفتح ملف', 'propose_registration', newPatient);
    expect(proposed.outcome).toBe('confirmation_required');
    const done = await a1('إيه', 'confirm_pending_action', { action_ref: proposed.output['action_ref'], caller_answer: 'yes' });
    expect(done.outcome).toBe('done');

    const lookup = { national_id: newPatient.national_id, phone: null, birth_date: newPatient.birth_date };
    expect((await call(a, 'ses_a2')('رقمي', 'find_patient', lookup)).outcome).toBe('verified');
    expect((await call(b, 'ses_b1')('رقمي', 'find_patient', lookup)).outcome).toBe('not_verified');
    expect(await b.system.findPatients({ tenant: { tenantId: b.profile.tenantId, agentId: b.profile.agentId }, signal: AbortSignal.timeout(5000), correlationId: 't' }, { nationalId: newPatient.national_id })).toEqual([]);
  });

  it('refs and pending confirmations never cross sessions, even within one clinic', async () => {
    const [a, b] = await Promise.all([clinic(CLINIC_A), clinic(CLINIC_B)]);
    const a1 = call(a, 'ses_a1');
    const verified = await a1('رقمي', 'find_patient', { national_id: '1000000100', phone: null, birth_date: '1990-03-14' });
    const ref = patientRef(verified.output);
    expect((await a1('مواعيدي', 'list_patient_appointments', { patient_ref: ref })).outcome).toBe('ok');
    expect((await call(a, 'ses_a2')('مواعيدي', 'list_patient_appointments', { patient_ref: ref })).outcome).toBe('unknown_ref');
    expect((await call(b, 'ses_b1')('مواعيدي', 'list_patient_appointments', { patient_ref: ref })).outcome).toBe('unknown_ref');

    const proposed = await a1('أبي ألغي', 'propose_registration', { full_name: 'مريض آخر', national_id: '1000000900', phone: '0500000298', birth_date: '1990-01-01', gender: 'female' });
    const actionRef = proposed.output['action_ref'];
    expect((await call(a, 'ses_a3')('إيه', 'confirm_pending_action', { action_ref: actionRef, caller_answer: 'yes' })).outcome).toBe('unknown_action');
    expect((await call(b, 'ses_b2')('إيه', 'confirm_pending_action', { action_ref: actionRef, caller_answer: 'yes' })).outcome).toBe('unknown_action');
  });

  it("a clinic's scheduling system refuses another tenant's context", async () => {
    const [a, b] = await Promise.all([clinic(CLINIC_A), clinic(CLINIC_B)]);
    const asB = { tenant: { tenantId: b.profile.tenantId, agentId: b.profile.agentId }, signal: AbortSignal.timeout(5000), correlationId: 't' };
    await expect(a.system.findPatients(asB, { nationalId: '1000000100' })).rejects.toBeInstanceOf(ProviderError);
  });

  it('refuses several clinics on the single Medplum sandbox project', () => {
    const memory = loadSettings(FAKES);
    const medplum = { ...memory, scheduling: { ...memory.scheduling, provider: 'medplum' as const } };
    expect(() => assertSchedulingServesOneTenant(medplum, ['demo', 'demo-b'])).toThrow(/one project for one tenant/);
    expect(() => assertSchedulingServesOneTenant(medplum, ['demo', 'demo'])).not.toThrow();
    expect(() => assertSchedulingServesOneTenant(memory, ['demo', 'demo-b'])).not.toThrow();
  });
});

describe('two clinics: four concurrent calls on one gateway', () => {
  const CREDENTIALS = { username: 'asterisk', password: 'test-only-secret' };
  let server: TelephonyServer | undefined;
  const callers: FakeAsterisk[] = [];
  afterEach(async () => {
    for (const c of callers.splice(0)) c.ws.terminate();
    await server?.close();
    server = undefined;
  });

  function runtime(profile: AgentProfile, tts: FakeTextToSpeech, metrics: MemoryTurnSink): AgentRuntime {
    return {
      profile,
      providers: { stt: new FakeSpeechToText({ mode: 'energy' }), llm: new FakeLanguageModel(), tts },
      sessionConfig: TEST_CONFIG,
      metrics,
    };
  }

  it('routes each call to its clinic, keeps them apart, and ending one leaves the others running', async () => {
    const [a, b] = await Promise.all([loadAgentProfile(CLINIC_A), loadAgentProfile(CLINIC_B)]);
    const metrics = new MemoryTurnSink(); // shared, like the gateway's JSONL sink
    const ttsA = new FakeTextToSpeech({ msPerChar: 25, realtimeFactor: 0.2 });
    const ttsB = new FakeTextToSpeech({ msPerChar: 25, realtimeFactor: 0.2 });
    server = await startTelephonyServer({
      host: '127.0.0.1',
      port: 0,
      credentials: CREDENTIALS,
      maxCalls: 4,
      callStartTimeoutMs: 500,
      router: new CallRouter([
        ['300', runtime(a, ttsA, metrics)],
        ['301', runtime(b, ttsB, metrics)],
      ]),
      log: silentLogger,
    });
    const plan = [
      { did: '300', id: 'A1' },
      { did: '301', id: 'B1' },
      { did: '300', id: 'A2' },
      { did: '301', id: 'B2' },
    ];
    const calls = await Promise.all(
      plan.map(async (p) => {
        const caller = await connectFakeAsterisk(server?.url ?? '', { ...CREDENTIALS, autoAckMarks: true, autoStatus: true });
        callers.push(caller);
        caller.mediaStart({ MUJEEB_DID: p.did, MUJEEB_CALL_ID: p.id });
        return { ...p, caller };
      }),
    );
    for (const c of calls) await waitFor(() => c.caller.commands().includes('MARK_MEDIA:start:1'), 4000, `${c.id} greeting`);
    expect(server.activeCalls()).toBe(4);

    // Each clinic's voice speaks only its own greeting, once per call (segments arrive as the greeting plays).
    const ownGreeting = (tts: FakeTextToSpeech, own: string | undefined, other: string | undefined): boolean =>
      tts.utterances.length === 2 &&
      tts.utterances.every((u) => {
        const said = u.segments.join('');
        return said !== '' && (own ?? '').startsWith(said) && !(other ?? '').startsWith(said);
      });
    expect(ownGreeting(ttsA, a.greeting, b.greeting)).toBe(true);
    expect(ownGreeting(ttsB, b.greeting, a.greeting)).toBe(true);

    // One call ends; the other three still hold a conversation.
    const [first, ...rest] = calls;
    first?.caller.ws.close(1000);
    await waitFor(() => server?.activeCalls() === 3, 2000, 'one call released');
    await delay(400); // let the greetings finish
    for (const c of rest) {
      for (let i = 0; i < 40; i += 1) c.caller.sendAudio(frame(true));
      for (let i = 0; i < 45; i += 1) c.caller.sendAudio(frame(false));
    }
    for (const c of rest) await waitFor(() => c.caller.commands().includes('MARK_MEDIA:start:2'), 8000, `${c.id} reply`);

    // Every turn is recorded under its own call and its own clinic.
    await waitFor(() => metrics.summaries.filter((t) => t.kind === 'user').length >= 3, 8000, 'user turns');
    const tenantByCall = new Map(plan.map((p) => [p.id, p.did === '300' ? a.tenantId : b.tenantId]));
    expect(metrics.summaries.length).toBeGreaterThanOrEqual(7);
    for (const t of metrics.summaries) expect(t.tenant_id).toBe(tenantByCall.get(t.call_id ?? ''));
    expect(new Set(metrics.summaries.map((t) => t.session_id)).size).toBe(4);
  });
});
