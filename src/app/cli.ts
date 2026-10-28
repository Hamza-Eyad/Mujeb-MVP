import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Settings, describeSettings, loadSettings } from '../config/settings.js';
import { describeFormat, durationMs } from '../core/audio.js';
import { ConfigError } from '../core/errors.js';
import type { Logger } from '../core/logger.js';
import { createJsonLogger } from '../observability/logger.js';
import { JsonlTurnSink, type TurnSummarySink } from '../observability/turn-metrics.js';
import { loadAgentProfile } from './agent-profile.js';
import { CallRouter, loadCallRoutes } from './call-router.js';
import { applyProfileDataset, applyProfileVoice, assertSchedulingServesOneTenant, buildSessionConfig, createProviders, createScheduling, createTts } from './container.js';
import { startDevServer } from './dev-server.js';
import { renderPrompt } from './render-prompt.js';
import type { AgentRuntime } from './session-factory.js';
import { TELEPHONY_AUDIO_FORMAT, startTelephonyServer } from './telephony-server.js';
import { runElevenLabsProbe } from './elevenlabs-probe.js';
import { buildLatencyReport, formatLatencyReport } from './latency-report.js';
import { runSeedCommand } from './medplum-seed-command.js';

const STATIC_DIR = fileURLToPath(new URL('../../web/dev-client', import.meta.url));

/** One clinic's agent, ready to run sessions: its profile, its voice, its providers and its scheduling system. */
async function buildAgentRuntime(envSettings: Settings, profilePath: string, metrics: TurnSummarySink, log: Logger): Promise<{ runtime: AgentRuntime; settings: Settings }> {
  const profile = await loadAgentProfile(profilePath);
  const settings = applyProfileDataset(applyProfileVoice(envSettings, profile), profile);
  const scheduling = await createScheduling(settings, profile.tenantId, log);
  if (scheduling && !profile.appointmentTools) {
    throw new ConfigError('MUJEEB_SCHEDULING_PROVIDER enables appointment tools, but the agent profile has no appointmentTools section');
  }
  if (scheduling && profile.appointmentTools) {
    log.info('privacy.verification_policy', {
      tenant_id: profile.tenantId,
      policy: profile.appointmentTools.patientVerification,
      production_grade: false,
      reminder: 'Development-only patient verification (DECISIONS A17). Synthetic scheduling data only.',
    });
  }
  const runtime: AgentRuntime = {
    profile,
    providers: createProviders(settings),
    sessionConfig: buildSessionConfig(settings),
    metrics,
    ...(scheduling
      ? {
          scheduling: {
            system: scheduling,
            readTimeoutMs: settings.scheduling.readTimeoutMs,
            writeTimeoutMs: settings.scheduling.writeTimeoutMs,
            confirmGraceMs: settings.voice.toolConfirmGraceMs,
          },
        }
      : {}),
  };
  return { runtime, settings };
}

function logPrivacyMode(settings: Settings, log: Logger): void {
  log.info('privacy.retention_mode', {
    openai_store: false,
    elevenlabs_zero_retention_requested: settings.elevenlabs.zeroRetention,
    transcripts_in_logs: settings.log.transcripts,
    reminder: 'Never use real patient data. Zero retention is Enterprise-only — verify with npm run probe:elevenlabs.',
  });
}

function onShutdown(log: Logger, close: () => Promise<void>): void {
  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('app.shutdown', { signal });
    void close().finally(() => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

function providersLabel(settings: Settings, fake: boolean): string {
  return fake ? 'FAKE' : `${settings.stt.provider}/${settings.llm.provider}/${settings.tts.provider}`;
}

async function serve(fake: boolean): Promise<void> {
  const envSettings = loadSettings(process.env, { forceFakeProviders: fake });
  const log = createJsonLogger({ level: envSettings.log.level });
  const metrics = new JsonlTurnSink(envSettings.log.dir);
  const { runtime, settings } = await buildAgentRuntime(envSettings, envSettings.agentProfilePath, metrics, log);
  log.info('app.config', { ...describeSettings(settings), voice_from_profile: runtime.profile.voiceId !== undefined });
  logPrivacyMode(settings, log);
  const server = await startDevServer({
    host: settings.dev.host,
    port: settings.dev.port,
    staticDir: STATIC_DIR,
    maxSessions: 2,
    ...runtime,
    log,
    displayConfig: describeSettings(settings),
  });
  process.stderr.write(`\nمُجيب dev server: ${server.url}  (providers: ${providersLabel(settings, fake)}; appointment tools: ${runtime.scheduling ? runtime.scheduling.system.name : 'off'})\n\n`);
  onShutdown(log, () => server.close().then(() => metrics.close()));
}

/** The telephony gateway: Asterisk connects one WebSocket per call; each dialed number routes to a clinic profile. */
async function telephony(fake: boolean): Promise<void> {
  const settings = loadSettings(process.env, { forceFakeProviders: fake });
  const { telephony: t } = settings;
  if (t.password === undefined) {
    throw new ConfigError('MUJEEB_TELEPHONY_PASSWORD is required: the shared secret Asterisk sends (websocket_client.conf username/password).');
  }
  const log = createJsonLogger({ level: settings.log.level });
  log.info('app.config', describeSettings(settings));
  logPrivacyMode(settings, log);
  const metrics = new JsonlTurnSink(settings.log.dir);
  const routes = await loadCallRoutes(t.routesPath);
  const byProfile = new Map<string, AgentRuntime>();
  const entries: Array<[string, AgentRuntime]> = [];
  for (const route of routes.routes) {
    let runtime = byProfile.get(route.agentProfile);
    if (runtime === undefined) {
      runtime = (await buildAgentRuntime(settings, route.agentProfile, metrics, log)).runtime;
      byProfile.set(route.agentProfile, runtime);
    }
    entries.push([route.key, runtime]);
  }
  assertSchedulingServesOneTenant(settings, [...byProfile.values()].map((r) => r.profile.tenantId));
  const server = await startTelephonyServer({
    host: t.host,
    port: t.port,
    credentials: { username: t.username, password: t.password },
    maxCalls: t.maxCalls,
    callStartTimeoutMs: t.callStartTimeoutMs,
    statusProbeMs: t.statusProbeMs,
    healthLogMs: t.healthLogMs,
    router: new CallRouter(entries),
    log,
  });
  process.stderr.write(`\nمُجيب telephony gateway: ${server.url}  (routes: ${entries.length}; max calls: ${t.maxCalls}; providers: ${providersLabel(settings, fake)})\n\n`);
  onShutdown(log, () => server.close().then(() => metrics.close()));
}

async function probe(): Promise<void> {
  const envSettings = loadSettings({ ...process.env, MUJEEB_LLM_PROVIDER: 'fake' });
  // Probe the voice the clinic would actually use.
  const settings = applyProfileVoice(envSettings, await loadAgentProfile(envSettings.agentProfilePath));
  const log = createJsonLogger({ level: 'warn' });
  const result = await runElevenLabsProbe(settings, log);
  mkdirSync(settings.log.dir, { recursive: true });
  const file = join(settings.log.dir, `probe-elevenlabs-${result.timestamp.replace(/[:.]/g, '-')}.json`);
  writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`);
  const out: string[] = [`STT model: ${result.stt_model ?? '-'}`];
  for (const c of result.stt) {
    out.push(
      `  commit=${c.requested.commit_strategy.padEnd(15)} zero_retention=${String(c.requested.zero_retention).padEnd(5)} → ${c.outcome}` +
        (c.applied ? `  applied: commit_strategy=${String(c.applied.commit_strategy)}${c.applied.zero_retention !== undefined ? ` zero_retention=${String(c.applied.zero_retention)}` : ''}` : '') +
        (c.error ? `  (${c.error})` : '') +
        (c.diagnosis ? `
      diagnosis: ${c.diagnosis}` : ''),
    );
  }
  if (result.tts) {
    out.push(`TTS model: ${result.tts_model ?? '-'} → ${result.tts.outcome}  first_audio_ms=${result.tts.first_audio_ms ?? '-'} audio_ms=${result.tts.audio_ms ?? '-'} alignment=${String(result.tts.alignment ?? '-')}${result.tts.error ? `  (${result.tts.error})` : ''}${result.tts.diagnosis ? `
      diagnosis: ${result.tts.diagnosis}` : ''}`);
  }
  if (result.roundtrip) out.push(`Round trip: ${result.roundtrip.outcome}\n  sent:  ${result.roundtrip.sent_text}\n  heard: ${result.roundtrip.transcript ?? result.roundtrip.error ?? '-'}`);
  out.push(`\nFull result: ${file}`);
  process.stdout.write(`${out.join('\n')}\n`);
}

async function seedMedplum(args: string[]): Promise<void> {
  // Voice providers are irrelevant here, and the seed always targets Medplum whatever the scheduling provider is.
  const settings = loadSettings({ ...process.env, MUJEEB_LLM_PROVIDER: 'fake', MUJEEB_STT_PROVIDER: 'fake', MUJEEB_TTS_PROVIDER: 'fake', MUJEEB_SCHEDULING_PROVIDER: 'none' });
  const log = createJsonLogger({ level: 'warn' });
  const profile = await loadAgentProfile(settings.agentProfilePath);
  const apply = args.includes('--apply');
  const result = await runSeedCommand(settings, { tenantId: profile.tenantId, agentId: profile.agentId }, log, {
    apply,
    resetAppointments: args.includes('--reset-appointments'),
    outDir: settings.log.dir,
  });
  const out = [
    `Medplum seed plan (synthetic data) — anchor day ${result.plan.anchorDate} (${result.plan.timezone})`,
    ...Object.entries(result.plan.counts).map(([type, n]) => `  ${type}: ${n}`),
    `Order: ${[...new Set(result.plan.resources.map((r) => r.resourceType))].join(' → ')} → leave blocks → appointments (one request at a time, no FHIR transaction)`,
    `Plan file: ${result.planFile}`,
  ];
  const issues = (label: string, list: readonly { key: string; reason: string }[]): string[] => list.map((i) => `  ${label} ${i.key}: ${i.reason}`);
  if (!apply) {
    out.push('', 'DRY RUN — nothing was sent to Medplum. To write it: npm run seed:medplum -- --apply');
  } else if (result.report) {
    const r = result.report;
    out.push(
      '',
      r.complete ? 'Status: COMPLETE' : 'Status: INCOMPLETE — fix the causes below and re-run; it resumes without duplicating anything',
      `Resources: ${r.resources.created.length} created, ${r.resources.existing.length} already present, ${r.resources.failed.length} failed, ${r.resources.uncertain.length} uncertain`,
      ...issues('failed', r.resources.failed),
      ...issues('UNCERTAIN', r.resources.uncertain),
      `Leave blocks: ${r.blocks.created.length} created, ${r.blocks.moved.length} moved to the plan's dates, ${r.blocks.unchanged.length} unchanged`,
      ...issues('failed', r.blocks.failed),
      ...issues('UNCERTAIN', r.blocks.uncertain),
      ...(r.reset
        ? [
            `Reset: ${r.reset.cancelled.length} unchanged seed appointments cancelled; ${r.reset.kept.length} seed appointments kept; ${r.reset.notSeeded} appointments not made by the seed left untouched`,
            ...issues('kept', r.reset.kept),
            ...issues('failed', r.reset.failed),
            ...issues('UNCERTAIN', r.reset.uncertain),
          ]
        : []),
      `Appointments: ${r.appointments.booked.length} booked, ${r.appointments.alreadyPresent.length} already present, ${r.appointments.failed.length} failed, ${r.appointments.uncertain.length} uncertain`,
      ...issues('failed', r.appointments.failed),
      ...issues('UNCERTAIN', r.appointments.uncertain),
      ...(r.appointments.unmarked.length > 0
        ? [`  WARNING: Medplum did not keep the seed markers on ${r.appointments.unmarked.join(', ')} — --reset-appointments cannot find them`]
        : []),
      ...r.verification.map((v) => `  free time for ${v.practitionerKey}/${v.serviceKey}: ${v.hasFreeTime ? 'yes' : 'NO'}${v.error ? ` (${v.error})` : ''}`),
      `Report file: ${result.reportFile ?? '-'}`,
    );
    if (!r.complete) process.exitCode = 1;
  }
  process.stdout.write(`${out.join('\n')}\n`);
}

/**
 * Renders a fixed prompt once, in the clinic's voice, as the telephony audio format (16 kHz PCM, Asterisk's
 * `.sln16`). Lab: the apology Asterisk plays when a call to Mujeeb fails (deploy/asterisk/lab/sounds/).
 */
async function renderPromptCommand(args: string[]): Promise<void> {
  const option = (name: string): string | undefined => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const textFile = option('--text-file');
  const out = option('--out');
  if (textFile === undefined || out === undefined) {
    throw new ConfigError('usage: render-prompt --text-file <prompt.txt> --out <prompt.sln16> [--profile <agent profile dir>]');
  }
  // Only the voice is needed: speech recognition and the language model stay fake, so their keys are not required.
  const envSettings = loadSettings({ ...process.env, MUJEEB_LLM_PROVIDER: 'fake', MUJEEB_STT_PROVIDER: 'fake' });
  const profile = await loadAgentProfile(option('--profile') ?? envSettings.agentProfilePath);
  const settings = applyProfileVoice(envSettings, profile);
  const log = createJsonLogger({ level: 'warn' });
  const audio = await renderPrompt(createTts(settings), readFileSync(textFile, 'utf8'), { format: TELEPHONY_AUDIO_FORMAT, log, timeoutMs: 30_000 });
  writeFileSync(out, audio);
  const voice = profile.voiceId !== undefined ? `the ${profile.agentId} profile` : 'MUJEEB_TTS_VOICE_ID';
  process.stdout.write(
    `${out}: ${Math.round(durationMs(audio.byteLength, TELEPHONY_AUDIO_FORMAT))} ms of ${describeFormat(TELEPHONY_AUDIO_FORMAT)}, TTS ${settings.tts.provider}, voice from ${voice}\n`,
  );
}

async function report(args: string[]): Promise<void> {
  const sinceIndex = args.indexOf('--since');
  const since = sinceIndex >= 0 ? args[sinceIndex + 1] : undefined;
  const logDir = process.env['MUJEEB_LOG_DIR']?.trim() || 'logs';
  const result = await buildLatencyReport(logDir, since !== undefined ? { since } : {});
  process.stdout.write(`${formatLatencyReport(result)}\n`);
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  switch (command) {
    case 'serve':
      await serve(args.includes('--fake'));
      return;
    case 'telephony':
      await telephony(args.includes('--fake'));
      return;
    case 'probe-elevenlabs':
      await probe();
      return;
    case 'report':
      await report(args);
      return;
    case 'seed-medplum':
      await seedMedplum(args);
      return;
    case 'render-prompt':
      await renderPromptCommand(args);
      return;
    default:
      process.stderr.write(
        'usage: cli.js <serve [--fake] | telephony [--fake] | probe-elevenlabs | report [--since YYYY-MM-DD] | seed-medplum [--apply] [--reset-appointments] | render-prompt --text-file <f> --out <f.sln16> [--profile <dir>]>\n',
      );
      process.exitCode = 2;
  }
}

main().catch((err: unknown) => {
  if (err instanceof ConfigError) {
    process.stderr.write(`\nConfiguration error: ${err.message}\n\n`);
  } else {
    process.stderr.write(`\nFatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  }
  process.exit(1);
});
