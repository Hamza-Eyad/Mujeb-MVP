import { ElevenLabsTts } from '../adapters/elevenlabs/multi-context-tts.js';
import { ElevenLabsRealtimeStt } from '../adapters/elevenlabs/realtime-stt.js';
import { FakeLanguageModel } from '../adapters/fakes/fake-llm.js';
import { FakeSpeechToText } from '../adapters/fakes/fake-stt.js';
import { FakeTextToSpeech } from '../adapters/fakes/fake-tts.js';
import { MemorySchedulingSystem } from '../adapters/fakes/memory-scheduling.js';
import { MedplumClient } from '../adapters/medplum/client.js';
import { MedplumSchedulingSystem } from '../adapters/medplum/medplum-scheduling.js';
import { OpenAiResponsesModel } from '../adapters/openai/responses-model.js';
import type { Settings } from '../config/settings.js';
import type { AgentProfile } from '../contracts/agent-profile.js';
import { ConfigError } from '../core/errors.js';
import type { Logger } from '../core/logger.js';
import type { LanguageModel } from '../ports/language-model.js';
import type { SchedulingSystem } from '../ports/scheduling.js';
import type { SpeechToText } from '../ports/speech-to-text.js';
import type { TextToSpeech } from '../ports/text-to-speech.js';
import { DEFAULT_BARGE_IN_POLICY } from '../voice/barge-in-policy.js';
import { DEFAULT_ENERGY_VAD_OPTIONS } from '../voice/energy-vad.js';
import type { VoiceSessionConfig } from '../voice/session.js';
import { DEFAULT_CHUNKER_OPTIONS } from '../voice/text-chunker.js';
import { loadSchedulingDataset } from './scheduling-dataset.js';

/**
 * Composition root: the only place that maps configuration to concrete adapters.
 * Swapping a provider means adding an adapter and a branch here — nothing else changes.
 */

export interface Providers {
  stt: SpeechToText;
  llm: LanguageModel;
  tts: TextToSpeech;
}

/** The clinic profile's voice wins over the environment default (MUJEEB_TTS_VOICE_ID). */
export function applyProfileVoice(s: Settings, profile: Pick<AgentProfile, 'voiceId'>): Settings {
  return profile.voiceId === undefined ? s : { ...s, tts: { ...s.tts, voiceId: profile.voiceId } };
}

/**
 * Several clinics on one gateway need a scheduling system per tenant. The in-memory system is built per
 * clinic from its own dataset. The Medplum sandbox is one project with one set of credentials (DECISIONS
 * A15): every clinic would reach the same data, so it serves one tenant only.
 */
export function assertSchedulingServesOneTenant(s: Settings, tenantIds: readonly string[]): void {
  const tenants = [...new Set(tenantIds)];
  if (s.scheduling.provider === 'medplum' && tenants.length > 1) {
    throw new ConfigError(
      `The routes serve ${tenants.length} clinics (${tenants.join(', ')}), but the Medplum sandbox is one project for one tenant (DECISIONS A15). Use MUJEEB_SCHEDULING_PROVIDER=memory for several clinics.`,
    );
  }
}

/**
 * A call is answered only once STT is connected: both STT attempts and the pause between them must fit in
 * MUJEEB_TELEPHONY_ANSWER_TIMEOUT_MS, which itself stays below the dialplan's Dial timeout.
 */
export function assertAnswerTimeoutCoversStt(s: Settings): void {
  const { attempts, attemptTimeoutMs, retryDelayMs } = buildSessionConfig(s).sttConnect;
  const budgetMs = attempts * attemptTimeoutMs + (attempts - 1) * retryDelayMs;
  if (budgetMs > s.telephony.answerTimeoutMs) {
    throw new ConfigError(
      `MUJEEB_TELEPHONY_ANSWER_TIMEOUT_MS (${s.telephony.answerTimeoutMs}) must be at least ${budgetMs}: ${attempts} STT attempts of MUJEEB_STT_CONNECT_TIMEOUT_MS (${attemptTimeoutMs}) and the pause between them`,
    );
  }
}

/** The clinic profile's synthetic dataset wins over the environment default (MUJEEB_SCHEDULING_DATASET). In-memory scheduling only. */
export function applyProfileDataset(s: Settings, profile: Pick<AgentProfile, 'schedulingDataset'>): Settings {
  return profile.schedulingDataset === undefined ? s : { ...s, scheduling: { ...s.scheduling, datasetPath: profile.schedulingDataset } };
}

export function createProviders(settings: Settings): Providers {
  return { stt: createStt(settings), llm: createLlm(settings), tts: createTts(settings) };
}

function createStt(s: Settings): SpeechToText {
  if (s.stt.provider === 'fake') return new FakeSpeechToText({ mode: 'energy' });
  return new ElevenLabsRealtimeStt({
    apiKey: required(s.elevenlabs.apiKey, 'ELEVENLABS_API_KEY'),
    baseUrl: s.elevenlabs.baseUrl,
    model: required(s.stt.model, 'MUJEEB_STT_MODEL'),
    languageCode: s.stt.languageCode,
    commitStrategy: s.stt.commitStrategy,
    vadSilenceSecs: s.stt.vadSilenceSecs,
    zeroRetention: s.elevenlabs.zeroRetention,
  });
}

function createLlm(s: Settings): LanguageModel {
  if (s.llm.provider === 'fake') return new FakeLanguageModel();
  return new OpenAiResponsesModel({
    apiKey: required(s.llm.apiKey, 'OPENAI_API_KEY'),
    model: required(s.llm.model, 'MUJEEB_LLM_MODEL'),
    ...(s.llm.reasoningEffort !== undefined ? { reasoningEffort: s.llm.reasoningEffort } : {}),
    ...(s.llm.maxOutputTokens !== undefined ? { maxOutputTokens: s.llm.maxOutputTokens } : {}),
    maxOutputTokensWithTools: s.llm.maxOutputTokensWithTools,
    assistantPhase: s.llm.assistantPhase,
  });
}

/**
 * The scheduling system behind the appointment tools, shared by all sessions of a tenant (like a real HIS).
 * `none` disables the tools. Adding a real system = a new adapter and a branch here.
 */
export async function createScheduling(s: Settings, tenantId: string, log?: Logger): Promise<SchedulingSystem | undefined> {
  if (s.scheduling.provider === 'none') return undefined;
  if (s.scheduling.provider === 'medplum') {
    const client = new MedplumClient({
      baseUrl: s.medplum.baseUrl,
      clientId: required(s.medplum.clientId, 'MEDPLUM_CLIENT_ID'),
      clientSecret: required(s.medplum.clientSecret, 'MEDPLUM_CLIENT_SECRET'),
      ...(log ? { log: log.child({ component: 'scheduling', provider: 'medplum' }) } : {}),
    });
    return new MedplumSchedulingSystem({ tenantId, client, nationalIdSystem: s.medplum.nationalIdSystem, directoryTtlMs: s.medplum.directoryTtlMs });
  }
  const dataset = await loadSchedulingDataset(s.scheduling.datasetPath);
  return new MemorySchedulingSystem({ tenantId, dataset });
}

export function createTts(s: Settings): TextToSpeech {
  if (s.tts.provider === 'fake') return new FakeTextToSpeech();
  if (s.tts.voiceId === undefined) {
    throw new ConfigError('No TTS voice: set "voiceId" in the clinic profile (profile.json), or MUJEEB_TTS_VOICE_ID in .env as the default');
  }
  return new ElevenLabsTts({
    apiKey: required(s.elevenlabs.apiKey, 'ELEVENLABS_API_KEY'),
    baseUrl: s.elevenlabs.baseUrl,
    model: required(s.tts.model, 'MUJEEB_TTS_MODEL'),
    voiceId: s.tts.voiceId,
    zeroRetention: s.elevenlabs.zeroRetention,
  });
}

export function buildSessionConfig(s: Settings): VoiceSessionConfig {
  return {
    sttChunkMs: s.voice.sttChunkMs,
    duplexMode: s.voice.duplexMode,
    falseInterruptionTimeoutMs: s.voice.falseInterruptionTimeoutMs,
    echoTailMs: s.voice.echoTailMs,
    llmFirstTokenTimeoutMs: s.llm.firstTokenTimeoutMs,
    ttsFirstAudioTimeoutMs: s.tts.firstAudioTimeoutMs,
    playbackGraceMs: 4000,
    clearAckTimeoutMs: 1000,
    sttConnect: { attempts: 2, attemptTimeoutMs: s.stt.connectTimeoutMs, retryDelayMs: 250 },
    sttReconnect: { maxAttempts: 4, baseDelayMs: 250 },
    chunker: DEFAULT_CHUNKER_OPTIONS,
    bargeIn: DEFAULT_BARGE_IN_POLICY,
    vad: DEFAULT_ENERGY_VAD_OPTIONS,
    logTranscripts: s.log.transcripts,
  };
}

function required(value: string | undefined, name: string): string {
  if (value === undefined) throw new ConfigError(`${name} is required`);
  return value;
}
