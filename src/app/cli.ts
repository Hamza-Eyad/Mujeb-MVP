import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeSettings, loadSettings } from '../config/settings.js';
import { ConfigError } from '../core/errors.js';
import { createJsonLogger } from '../observability/logger.js';
import { JsonlTurnSink } from '../observability/turn-metrics.js';
import { loadAgentProfile } from './agent-profile.js';
import { applyProfileVoice, buildSessionConfig, createProviders, createScheduling } from './container.js';
import { startDevServer } from './dev-server.js';
import { runElevenLabsProbe } from './elevenlabs-probe.js';
import { buildLatencyReport, formatLatencyReport } from './latency-report.js';
import { runSeedCommand } from './medplum-seed-command.js';

const STATIC_DIR = fileURLToPath(new URL('../../web/dev-client', import.meta.url));

async function serve(fake: boolean): Promise<void> {
  const envSettings = loadSettings(process.env, { forceFakeProviders: fake });
  const log = createJsonLogger({ level: envSettings.log.level });
  const profile = await loadAgentProfile(envSettings.agentProfilePath);
  const settings = applyProfileVoice(envSettings, profile);
  log.info('app.config', { ...describeSettings(settings), voice_from_profile: profile.voiceId !== undefined });
  log.info('privacy.retention_mode', {
    openai_store: false,
    elevenlabs_zero_retention_requested: settings.elevenlabs.zeroRetention,
    transcripts_in_logs: settings.log.transcripts,
    reminder: 'Phase 0: never use real patient data. Zero retention is Enterprise-only — verify with npm run probe:elevenlabs.',
  });
  const scheduling = await createScheduling(settings, profile.tenantId, log);
  if (scheduling && !profile.appointmentTools) {
    throw new ConfigError('MUJEEB_SCHEDULING_PROVIDER enables appointment tools, but the agent profile has no appointmentTools section');
  }
  if (scheduling && profile.appointmentTools) {
    log.info('privacy.verification_policy', {
      policy: profile.appointmentTools.patientVerification,
      production_grade: false,
      reminder: 'Development-only patient verification (DECISIONS A17). Synthetic scheduling data only.',
    });
  }
  const metrics = new JsonlTurnSink(settings.log.dir);
  const server = await startDevServer({
    host: settings.dev.host,
    port: settings.dev.port,
    staticDir: STATIC_DIR,
    maxSessions: 2,
    profile,
    providers: createProviders(settings),
    sessionConfig: buildSessionConfig(settings),
    metrics,
    log,
    displayConfig: describeSettings(settings),
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
  });
  process.stderr.write(`\nمُجيب dev server: ${server.url}  (providers: ${fake ? 'FAKE' : `${settings.stt.provider}/${settings.llm.provider}/${settings.tts.provider}`}; appointment tools: ${scheduling ? scheduling.name : 'off'})\n\n`);

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('app.shutdown', { signal });
    void server
      .close()
      .then(() => metrics.close())
      .finally(() => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
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
    case 'probe-elevenlabs':
      await probe();
      return;
    case 'report':
      await report(args);
      return;
    case 'seed-medplum':
      await seedMedplum(args);
      return;
    default:
      process.stderr.write('usage: cli.js <serve [--fake] | probe-elevenlabs | report [--since YYYY-MM-DD] | seed-medplum [--apply] [--reset-appointments]>\n');
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
