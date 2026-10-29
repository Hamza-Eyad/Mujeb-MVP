import { AppointmentTools } from '../agent/tools/appointment-tools.js';
import type { AgentProfile } from '../contracts/agent-profile.js';
import type { Logger } from '../core/logger.js';
import { type SessionChannel, type TurnSummarySink, withSessionFields } from '../observability/turn-metrics.js';
import type { AudioTransport } from '../ports/audio-transport.js';
import type { LanguageModel } from '../ports/language-model.js';
import type { SchedulingSystem } from '../ports/scheduling.js';
import type { SpeechToText } from '../ports/speech-to-text.js';
import type { TextToSpeech } from '../ports/text-to-speech.js';
import { type SessionEvent, VoiceSession, type VoiceSessionConfig } from '../voice/session.js';

/**
 * Everything one clinic's agent needs to run a session, built once at startup. Every entry point (the local
 * browser dev server, the telephony gateway) creates sessions from it the same way.
 */
export interface AgentRuntime {
  profile: AgentProfile;
  providers: { stt: SpeechToText; llm: LanguageModel; tts: TextToSpeech };
  sessionConfig: VoiceSessionConfig;
  metrics: TurnSummarySink;
  /** Enables the appointment tools (requires `profile.appointmentTools`). */
  scheduling?: { system: SchedulingSystem; readTimeoutMs: number; writeTimeoutMs: number; confirmGraceMs: number };
}

export interface SessionStart {
  sessionId: string;
  /** Recorded on every turn summary, so latency can be reported per channel. */
  channel: SessionChannel;
  /** Phone calls: the dialplan's call ID. */
  callId?: string;
  transport: AudioTransport;
  log: Logger;
  observer?: (event: SessionEvent) => void;
}

/** One VoiceSession for one connection: its own tools state (refs, verification, pending actions, writes). */
export function createVoiceSession(runtime: AgentRuntime, start: SessionStart): VoiceSession {
  const { profile, providers, scheduling } = runtime;
  const { sessionId, transport, log } = start;
  const tenant = { tenantId: profile.tenantId, agentId: profile.agentId };
  const toolsProfile = scheduling ? profile.appointmentTools : undefined;
  // One instance per session: refs, verification, pending actions and the write ledger belong to this call.
  const tools =
    scheduling && toolsProfile && profile.timezone !== undefined
      ? new AppointmentTools({
          scheduling: scheduling.system,
          tenant,
          sessionId,
          timeZone: profile.timezone,
          log: log.child({ session_id: sessionId }),
          verificationPolicy: toolsProfile.patientVerification,
          ...(toolsProfile.allowedTools ? { allowedTools: toolsProfile.allowedTools } : {}),
          pendingActionTtlMs: toolsProfile.pendingActionTtlSec * 1000,
          maxReconfirmations: toolsProfile.maxReconfirmations,
          readTimeoutMs: scheduling.readTimeoutMs,
          writeTimeoutMs: scheduling.writeTimeoutMs,
        })
      : undefined;
  return new VoiceSession({
    sessionId,
    tenant,
    agent: {
      instructions: tools && toolsProfile ? `${profile.instructions}\n\n${toolsProfile.instructions}` : profile.instructions,
      historyMaxTurns: profile.historyMaxTurns,
      ...(profile.greeting !== undefined ? { greeting: profile.greeting } : {}),
      ...(tools && toolsProfile && scheduling
        ? {
            maxToolRounds: toolsProfile.maxToolRounds,
            toolMutationGraceMs: scheduling.confirmGraceMs,
            toolDrainTimeoutMs: scheduling.writeTimeoutMs + 2 * scheduling.readTimeoutMs,
            ...(toolsProfile.waitPhrase !== undefined ? { toolWaitPhrase: toolsProfile.waitPhrase } : {}),
          }
        : {}),
    },
    transport,
    ...providers,
    ...(tools ? { tools } : {}),
    config: runtime.sessionConfig,
    log,
    metrics: withSessionFields(runtime.metrics, { channel: start.channel, ...(start.callId !== undefined ? { call_id: start.callId } : {}) }),
    ...(start.observer ? { observer: start.observer } : {}),
  });
}
