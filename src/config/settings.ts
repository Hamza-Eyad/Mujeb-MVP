import { z } from 'zod';
import { ConfigError } from '../core/errors.js';

/**
 * Environment → typed settings. All provider/model/env-specific values come from here.
 * Error messages name missing variables but never echo values.
 */

const optionalString = z.string().trim().min(1).optional();
const positiveMs = (fallback: number) => z.coerce.number().int().positive().default(fallback);

const envSchema = z.object({
  OPENAI_API_KEY: optionalString,
  ELEVENLABS_API_KEY: optionalString,

  MUJEEB_LLM_PROVIDER: z.enum(['openai', 'fake']).default('openai'),
  MUJEEB_LLM_MODEL: optionalString,
  MUJEEB_LLM_REASONING_EFFORT: z.enum(['none', 'minimal', 'low', 'medium', 'high']).optional(),
  MUJEEB_LLM_FIRST_TOKEN_TIMEOUT_MS: positiveMs(8000),
  MUJEEB_LLM_MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().optional(),
  MUJEEB_LLM_MAX_OUTPUT_TOKENS_TOOLS: z.coerce.number().int().positive().default(1024),
  MUJEEB_LLM_ASSISTANT_PHASE: z.stringbool().default(true),

  MUJEEB_STT_PROVIDER: z.enum(['elevenlabs', 'fake']).default('elevenlabs'),
  MUJEEB_STT_MODEL: optionalString,
  MUJEEB_STT_LANGUAGE: z.string().trim().min(2).default('ar'),
  MUJEEB_STT_COMMIT_STRATEGY: z.enum(['vad', 'turn_prediction']).default('vad'),
  MUJEEB_STT_VAD_SILENCE_SECS: z.coerce.number().min(0.2).max(3).default(0.8),
  MUJEEB_STT_CHUNK_MS: z.coerce.number().int().min(20).max(1000).default(100),

  MUJEEB_TTS_PROVIDER: z.enum(['elevenlabs', 'fake']).default('elevenlabs'),
  MUJEEB_TTS_MODEL: optionalString,
  MUJEEB_TTS_VOICE_ID: optionalString,
  MUJEEB_TTS_FIRST_AUDIO_TIMEOUT_MS: positiveMs(5000),

  MUJEEB_ELEVENLABS_BASE_URL: z.url().default('https://api.elevenlabs.io'),
  MUJEEB_ELEVENLABS_ZERO_RETENTION: z.stringbool().default(false),

  MUJEEB_DUPLEX_MODE: z.enum(['full', 'half']).default('full'),
  MUJEEB_FALSE_INTERRUPTION_TIMEOUT_MS: positiveMs(1500),
  MUJEEB_ECHO_TAIL_MS: z.coerce.number().int().min(0).default(1200),
  MUJEEB_TOOL_CONFIRM_GRACE_MS: z.coerce.number().int().min(0).max(3000).default(400),

  MUJEEB_SCHEDULING_PROVIDER: z.enum(['none', 'memory', 'medplum']).default('memory'),
  MUJEEB_SCHEDULING_DATASET: z.string().trim().min(1).default('config/test-data/demo-clinic.dataset.json'),
  MUJEEB_SCHEDULING_TIMEOUT_MS: positiveMs(4000),
  MUJEEB_SCHEDULING_WRITE_TIMEOUT_MS: positiveMs(8000),
  MUJEEB_SCHEDULING_DIRECTORY_TTL_SEC: z.coerce.number().int().min(0).max(86_400).default(300),

  MUJEEB_MEDPLUM_BASE_URL: z.url().default('https://api.medplum.com/'),
  MEDPLUM_CLIENT_ID: optionalString,
  MEDPLUM_CLIENT_SECRET: optionalString,
  MUJEEB_MEDPLUM_NATIONAL_ID_SYSTEM: z.string().trim().min(1).default('urn:mujeeb:identifier:national-id'),

  MUJEEB_AGENT_PROFILE: z.string().trim().min(1).default('config/agents/demo-clinic'),
  MUJEEB_DEV_HOST: z.string().trim().default('127.0.0.1'),
  MUJEEB_DEV_PORT: z.coerce.number().int().min(1).max(65535).default(8787),

  MUJEEB_TELEPHONY_HOST: z.string().trim().default('127.0.0.1'),
  MUJEEB_TELEPHONY_PORT: z.coerce.number().int().min(1).max(65535).default(8790),
  MUJEEB_TELEPHONY_ROUTES: z.string().trim().min(1).default('config/telephony/routes.json'),
  MUJEEB_TELEPHONY_MAX_CALLS: z.coerce.number().int().min(1).max(100).default(5),
  MUJEEB_TELEPHONY_USERNAME: z.string().trim().min(1).default('asterisk'),
  MUJEEB_TELEPHONY_PASSWORD: optionalString,
  MUJEEB_TELEPHONY_CALL_START_TIMEOUT_MS: positiveMs(3000),
  MUJEEB_TELEPHONY_STATUS_PROBE_MS: z.coerce.number().int().min(0).max(60_000).default(0),
  MUJEEB_TELEPHONY_HEALTH_LOG_MS: z.coerce.number().int().min(0).max(3_600_000).default(0),

  MUJEEB_LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  MUJEEB_LOG_DIR: z.string().trim().min(1).default('logs'),
  MUJEEB_LOG_TRANSCRIPTS: z.stringbool().default(false),
});

export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high';
export type CommitStrategy = 'vad' | 'turn_prediction';

export interface Settings {
  llm: {
    provider: 'openai' | 'fake';
    apiKey?: string;
    model?: string;
    reasoningEffort?: ReasoningEffort;
    firstTokenTimeoutMs: number;
    maxOutputTokens?: number;
    /** Budget when tools are offered: reasoning and call arguments count against it. */
    maxOutputTokensWithTools: number;
    /** Resend `phase` on assistant history (recommended for GPT-5.3+ models). */
    assistantPhase: boolean;
  };
  stt: {
    provider: 'elevenlabs' | 'fake';
    model?: string;
    languageCode: string;
    commitStrategy: CommitStrategy;
    vadSilenceSecs: number;
  };
  tts: {
    provider: 'elevenlabs' | 'fake';
    model?: string;
    voiceId?: string;
    firstAudioTimeoutMs: number;
  };
  elevenlabs: { apiKey?: string; baseUrl: string; zeroRetention: boolean };
  voice: {
    duplexMode: 'full' | 'half';
    sttChunkMs: number;
    falseInterruptionTimeoutMs: number;
    echoTailMs: number;
    toolConfirmGraceMs: number;
  };
  /** Appointment tools' scheduling system. `none`: no tools (the Phase 0 text-only agent). */
  scheduling: {
    provider: 'none' | 'memory' | 'medplum';
    datasetPath: string;
    readTimeoutMs: number;
    writeTimeoutMs: number;
  };
  /** Medplum sandbox (DECISIONS A15). Credentials are needed only when it is used. */
  medplum: { baseUrl: string; clientId?: string; clientSecret?: string; nationalIdSystem: string; directoryTtlMs: number };
  agentProfilePath: string;
  dev: { host: string; port: number };
  /**
   * Telephony gateway endpoint (Asterisk connects here, one WebSocket per call). `password` is needed only
   * when the gateway runs (the `telephony` command).
   */
  telephony: {
    host: string;
    port: number;
    routesPath: string;
    maxCalls: number;
    username: string;
    password?: string;
    callStartTimeoutMs: number;
    /** Log each call's Asterisk playback queue length this often (load tests). 0: off. */
    statusProbeMs: number;
    /** Log the gateway's health (calls, event-loop delay, memory) this often. 0: off. */
    healthLogMs: number;
  };
  log: { level: 'debug' | 'info' | 'warn' | 'error'; dir: string; transcripts: boolean };
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

export function loadSettings(env: NodeJS.ProcessEnv, options?: { forceFakeProviders?: boolean }): Settings {
  // Treat empty assignments (`KEY=`) as unset.
  const cleaned: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && value.trim() !== '') cleaned[key] = value;
  }
  const parsed = envSchema.safeParse(cleaned);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
    throw new ConfigError(`Invalid configuration:\n  - ${problems.join('\n  - ')}`);
  }
  const e = parsed.data;
  const fake = options?.forceFakeProviders === true;

  const settings: Settings = {
    llm: {
      provider: fake ? 'fake' : e.MUJEEB_LLM_PROVIDER,
      ...(e.OPENAI_API_KEY ? { apiKey: e.OPENAI_API_KEY } : {}),
      ...(e.MUJEEB_LLM_MODEL ? { model: e.MUJEEB_LLM_MODEL } : {}),
      ...(e.MUJEEB_LLM_REASONING_EFFORT ? { reasoningEffort: e.MUJEEB_LLM_REASONING_EFFORT } : {}),
      firstTokenTimeoutMs: e.MUJEEB_LLM_FIRST_TOKEN_TIMEOUT_MS,
      ...(e.MUJEEB_LLM_MAX_OUTPUT_TOKENS ? { maxOutputTokens: e.MUJEEB_LLM_MAX_OUTPUT_TOKENS } : {}),
      maxOutputTokensWithTools: e.MUJEEB_LLM_MAX_OUTPUT_TOKENS_TOOLS,
      assistantPhase: e.MUJEEB_LLM_ASSISTANT_PHASE,
    },
    stt: {
      provider: fake ? 'fake' : e.MUJEEB_STT_PROVIDER,
      ...(e.MUJEEB_STT_MODEL ? { model: e.MUJEEB_STT_MODEL } : {}),
      languageCode: e.MUJEEB_STT_LANGUAGE,
      commitStrategy: e.MUJEEB_STT_COMMIT_STRATEGY,
      vadSilenceSecs: e.MUJEEB_STT_VAD_SILENCE_SECS,
    },
    tts: {
      provider: fake ? 'fake' : e.MUJEEB_TTS_PROVIDER,
      ...(e.MUJEEB_TTS_MODEL ? { model: e.MUJEEB_TTS_MODEL } : {}),
      ...(e.MUJEEB_TTS_VOICE_ID ? { voiceId: e.MUJEEB_TTS_VOICE_ID } : {}),
      firstAudioTimeoutMs: e.MUJEEB_TTS_FIRST_AUDIO_TIMEOUT_MS,
    },
    elevenlabs: {
      ...(e.ELEVENLABS_API_KEY ? { apiKey: e.ELEVENLABS_API_KEY } : {}),
      baseUrl: e.MUJEEB_ELEVENLABS_BASE_URL,
      zeroRetention: e.MUJEEB_ELEVENLABS_ZERO_RETENTION,
    },
    voice: {
      duplexMode: e.MUJEEB_DUPLEX_MODE,
      sttChunkMs: e.MUJEEB_STT_CHUNK_MS,
      falseInterruptionTimeoutMs: e.MUJEEB_FALSE_INTERRUPTION_TIMEOUT_MS,
      echoTailMs: e.MUJEEB_ECHO_TAIL_MS,
      toolConfirmGraceMs: e.MUJEEB_TOOL_CONFIRM_GRACE_MS,
    },
    scheduling: {
      provider: e.MUJEEB_SCHEDULING_PROVIDER,
      datasetPath: e.MUJEEB_SCHEDULING_DATASET,
      readTimeoutMs: e.MUJEEB_SCHEDULING_TIMEOUT_MS,
      writeTimeoutMs: e.MUJEEB_SCHEDULING_WRITE_TIMEOUT_MS,
    },
    medplum: {
      baseUrl: e.MUJEEB_MEDPLUM_BASE_URL,
      ...(e.MEDPLUM_CLIENT_ID ? { clientId: e.MEDPLUM_CLIENT_ID } : {}),
      ...(e.MEDPLUM_CLIENT_SECRET ? { clientSecret: e.MEDPLUM_CLIENT_SECRET } : {}),
      nationalIdSystem: e.MUJEEB_MEDPLUM_NATIONAL_ID_SYSTEM,
      directoryTtlMs: e.MUJEEB_SCHEDULING_DIRECTORY_TTL_SEC * 1000,
    },
    agentProfilePath: e.MUJEEB_AGENT_PROFILE,
    dev: { host: e.MUJEEB_DEV_HOST, port: e.MUJEEB_DEV_PORT },
    telephony: {
      host: e.MUJEEB_TELEPHONY_HOST,
      port: e.MUJEEB_TELEPHONY_PORT,
      routesPath: e.MUJEEB_TELEPHONY_ROUTES,
      maxCalls: e.MUJEEB_TELEPHONY_MAX_CALLS,
      username: e.MUJEEB_TELEPHONY_USERNAME,
      ...(e.MUJEEB_TELEPHONY_PASSWORD ? { password: e.MUJEEB_TELEPHONY_PASSWORD } : {}),
      callStartTimeoutMs: e.MUJEEB_TELEPHONY_CALL_START_TIMEOUT_MS,
      statusProbeMs: e.MUJEEB_TELEPHONY_STATUS_PROBE_MS,
      healthLogMs: e.MUJEEB_TELEPHONY_HEALTH_LOG_MS,
    },
    log: { level: e.MUJEEB_LOG_LEVEL, dir: e.MUJEEB_LOG_DIR, transcripts: e.MUJEEB_LOG_TRANSCRIPTS },
  };

  const missing: string[] = [];
  if (settings.llm.provider === 'openai') {
    if (!settings.llm.apiKey) missing.push('OPENAI_API_KEY');
    if (!settings.llm.model) missing.push('MUJEEB_LLM_MODEL');
  }
  if (settings.stt.provider === 'elevenlabs' || settings.tts.provider === 'elevenlabs') {
    if (!settings.elevenlabs.apiKey) missing.push('ELEVENLABS_API_KEY');
  }
  if (settings.stt.provider === 'elevenlabs' && !settings.stt.model) missing.push('MUJEEB_STT_MODEL');
  // The voice is not required here: the clinic profile may name it (see applyProfileVoice in app/container.ts).
  if (settings.tts.provider === 'elevenlabs' && !settings.tts.model) missing.push('MUJEEB_TTS_MODEL');
  if (settings.scheduling.provider === 'medplum') {
    if (!settings.medplum.clientId) missing.push('MEDPLUM_CLIENT_ID (needed by MUJEEB_SCHEDULING_PROVIDER=medplum)');
    if (!settings.medplum.clientSecret) missing.push('MEDPLUM_CLIENT_SECRET (needed by MUJEEB_SCHEDULING_PROVIDER=medplum)');
  }
  if (missing.length > 0) {
    throw new ConfigError(
      `Missing required configuration: ${missing.join(', ')}. ` +
        'Set them in .env (see .env.example), or run with fake providers: npm run dev:fake',
    );
  }
  if (!LOOPBACK_HOSTS.has(settings.dev.host)) {
    throw new ConfigError('MUJEEB_DEV_HOST must be a loopback address: the local dev server has no authentication.');
  }
  if (!LOOPBACK_HOSTS.has(settings.telephony.host)) {
    throw new ConfigError('MUJEEB_TELEPHONY_HOST must be a loopback address: only Asterisk on the same host may reach the gateway.');
  }
  return settings;
}

/** Safe-to-log view: provider/model choices and key presence only. */
export function describeSettings(settings: Settings): Record<string, unknown> {
  return {
    llm: {
      provider: settings.llm.provider,
      model: settings.llm.model,
      reasoning_effort: settings.llm.reasoningEffort,
      // Not "max_output_tokens": the log redactor hides any key that mentions tokens.
      output_budget: settings.llm.maxOutputTokens,
      output_budget_with_tools: settings.llm.maxOutputTokensWithTools,
      assistant_phase: settings.llm.assistantPhase,
    },
    stt: {
      provider: settings.stt.provider,
      model: settings.stt.model,
      language: settings.stt.languageCode,
      commit_strategy: settings.stt.commitStrategy,
      vad_silence_secs: settings.stt.vadSilenceSecs,
    },
    tts: { provider: settings.tts.provider, model: settings.tts.model, voice_configured: Boolean(settings.tts.voiceId) },
    elevenlabs: { zero_retention_requested: settings.elevenlabs.zeroRetention, key_present: Boolean(settings.elevenlabs.apiKey) },
    openai_key_present: Boolean(settings.llm.apiKey),
    voice: settings.voice,
    scheduling: {
      provider: settings.scheduling.provider,
      dataset: settings.scheduling.provider === 'memory' ? settings.scheduling.datasetPath : undefined,
      medplum:
        settings.scheduling.provider === 'medplum'
          ? { base_url: settings.medplum.baseUrl, client_configured: Boolean(settings.medplum.clientId && settings.medplum.clientSecret) }
          : undefined,
    },
    telephony: {
      host: settings.telephony.host,
      port: settings.telephony.port,
      routes: settings.telephony.routesPath,
      max_calls: settings.telephony.maxCalls,
      status_probe_ms: settings.telephony.statusProbeMs,
      health_log_ms: settings.telephony.healthLogMs,
      credentials_configured: Boolean(settings.telephony.password),
    },
    log: settings.log,
  };
}
