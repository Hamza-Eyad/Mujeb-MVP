import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MedplumClient } from '../adapters/medplum/client.js';
import { MedplumSchedulingSystem } from '../adapters/medplum/medplum-scheduling.js';
import { type SeedPlan, type SeedReport, applySeedPlan, buildSeedPlan } from '../adapters/medplum/seed.js';
import type { Settings } from '../config/settings.js';
import { ConfigError } from '../core/errors.js';
import type { Logger } from '../core/logger.js';
import type { TenantContext } from '../core/tenant.js';
import { instantToZoned } from '../core/zoned-time.js';
import { loadSchedulingDataset } from './scheduling-dataset.js';

/**
 * `seed-medplum`: dry run by default — builds the plan from the synthetic dataset and writes it to the
 * log directory without any network call. Only `--apply` sends it to Medplum.
 */

export interface SeedCommandOptions {
  apply: boolean;
  resetAppointments: boolean;
  outDir: string;
  now?: Date;
  /** For tests. */
  fetch?: typeof fetch;
}

export interface SeedCommandResult {
  plan: SeedPlan;
  planFile: string;
  report?: SeedReport;
  reportFile?: string;
}

export async function runSeedCommand(settings: Settings, tenant: TenantContext, log: Logger, options: SeedCommandOptions): Promise<SeedCommandResult> {
  if (options.resetAppointments && !options.apply) throw new ConfigError('--reset-appointments only makes sense with --apply');
  const dataset = await loadSchedulingDataset(settings.scheduling.datasetPath);
  const now = options.now ?? new Date();
  const anchor = instantToZoned(now, dataset.clinic.timezone).date;
  const plan = buildSeedPlan(dataset, anchor, { nationalIdSystem: settings.medplum.nationalIdSystem });
  await mkdir(options.outDir, { recursive: true });
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const planFile = join(options.outDir, `medplum-seed-plan-${stamp}.json`);
  await writeFile(planFile, `${JSON.stringify(plan, null, 2)}\n`);
  if (!options.apply) return { plan, planFile };

  const { clientId, clientSecret } = settings.medplum;
  if (!clientId || !clientSecret) throw new ConfigError('MEDPLUM_CLIENT_ID and MEDPLUM_CLIENT_SECRET are required for --apply');
  const client = new MedplumClient({ baseUrl: settings.medplum.baseUrl, clientId, clientSecret, log, ...(options.fetch ? { fetch: options.fetch } : {}) });
  // The directory is first loaded after the transaction commits, so the normal cache lifetime is safe here.
  const scheduling = new MedplumSchedulingSystem({
    tenantId: tenant.tenantId,
    client,
    nationalIdSystem: settings.medplum.nationalIdSystem,
    directoryTtlMs: settings.medplum.directoryTtlMs,
  });
  const report = await applySeedPlan(plan, dataset, { client, scheduling, ctx: { tenant, signal: AbortSignal.timeout(180_000), correlationId: 'seed' }, log, now: () => now }, {
    resetAppointments: options.resetAppointments,
  });
  const reportFile = join(options.outDir, `medplum-seed-report-${stamp}.json`);
  await writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`);
  return { plan, planFile, report, reportFile };
}
