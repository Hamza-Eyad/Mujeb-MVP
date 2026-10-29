import { FakeLanguageModel, type FakeLlmOptions } from '../../src/adapters/fakes/fake-llm.js';
import type { AgentToolbox } from '../../src/agent/agent-turn.js';
import { FakeSpeechToText, type FakeSttOptions } from '../../src/adapters/fakes/fake-stt.js';
import { FakeTextToSpeech, type FakeTtsOptions } from '../../src/adapters/fakes/fake-tts.js';
import { silentLogger } from '../../src/core/logger.js';
import { MemoryTurnSink } from '../../src/observability/turn-metrics.js';
import type { LanguageModel } from '../../src/ports/language-model.js';
import type { TextToSpeech } from '../../src/ports/text-to-speech.js';
import { DEFAULT_BARGE_IN_POLICY } from '../../src/voice/barge-in-policy.js';
import { DEFAULT_ENERGY_VAD_OPTIONS } from '../../src/voice/energy-vad.js';
import { type SessionEvent, VoiceSession, type VoiceSessionConfig } from '../../src/voice/session.js';
import { DEFAULT_CHUNKER_OPTIONS } from '../../src/voice/text-chunker.js';
import { FakeTransport } from './fake-transport.js';

export const TEST_CONFIG: VoiceSessionConfig = {
  sttChunkMs: 100,
  duplexMode: 'full',
  falseInterruptionTimeoutMs: 150,
  echoTailMs: 200,
  llmFirstTokenTimeoutMs: 500,
  ttsFirstAudioTimeoutMs: 500,
  playbackGraceMs: 500,
  clearAckTimeoutMs: 200,
  sttConnect: { attempts: 2, attemptTimeoutMs: 150, retryDelayMs: 10 },
  sttReconnect: { maxAttempts: 3, baseDelayMs: 10 },
  chunker: DEFAULT_CHUNKER_OPTIONS,
  bargeIn: DEFAULT_BARGE_IN_POLICY,
  vad: DEFAULT_ENERGY_VAD_OPTIONS,
  logTranscripts: false,
};

export interface HarnessOptions {
  config?: Partial<VoiceSessionConfig>;
  llm?: FakeLlmOptions | LanguageModel;
  tts?: FakeTtsOptions | TextToSpeech;
  /** Scripted STT, with optional open failures or stalls. */
  stt?: Omit<FakeSttOptions, 'mode'>;
  greeting?: string;
  transport?: FakeTransport;
  sessionId?: string;
  /** Enables the tool-using path. */
  tools?: AgentToolbox;
  agent?: { maxToolRounds?: number; toolMutationGraceMs?: number; toolDrainTimeoutMs?: number; toolWaitPhrase?: string };
}

export function createHarness(options: HarnessOptions = {}) {
  const transport = options.transport ?? new FakeTransport();
  const stt = new FakeSpeechToText({ ...options.stt, mode: 'scripted' });
  const llm = isProvider(options.llm) ? options.llm : new FakeLanguageModel(options.llm);
  const tts = isProvider(options.tts) ? options.tts : new FakeTextToSpeech({ msPerChar: 25, ...options.tts });
  const sink = new MemoryTurnSink();
  const events: SessionEvent[] = [];
  const session = new VoiceSession({
    sessionId: options.sessionId ?? 'ses_test',
    tenant: { tenantId: 'demo', agentId: 'demo-clinic' },
    agent: { instructions: 'test instructions', historyMaxTurns: 10, ...(options.greeting ? { greeting: options.greeting } : {}), ...options.agent },
    transport,
    stt,
    llm,
    tts,
    config: { ...TEST_CONFIG, ...options.config },
    log: silentLogger,
    metrics: sink,
    observer: (event) => events.push(event),
    ...(options.tools ? { tools: options.tools } : {}),
  });
  return {
    session,
    transport,
    stt,
    llm,
    tts,
    sink,
    events,
    /** The current scripted STT stream (after start()). */
    get sttStream() {
      const stream = stt.current;
      if (!stream) throw new Error('STT not opened');
      return stream;
    },
    states: () => events.filter((e): e is Extract<SessionEvent, { type: 'state' }> => e.type === 'state').map((e) => e.state),
  };
}

function isProvider<T extends { name: string }>(value: unknown): value is T {
  return typeof value === 'object' && value !== null && 'name' in value;
}

export async function waitFor(predicate: () => boolean, timeoutMs = 3000, label = 'condition'): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 20ms PCM16 16k frame: a 220Hz tone (speech-like energy) or silence. */
export function frame(loud: boolean): Uint8Array {
  const samples = new Int16Array(320);
  if (loud) for (let i = 0; i < samples.length; i += 1) samples[i] = Math.round(8000 * Math.sin((2 * Math.PI * 220 * i) / 16000));
  return new Uint8Array(samples.buffer);
}

export function frames(loud: boolean, count: number): Uint8Array[] {
  return Array.from({ length: count }, () => frame(loud));
}
