import { afterAll, describe, expect, it } from 'vitest';
import { describeSchedulingContract, type SchedulingContractFixture } from '../contract/scheduling-system.contract.js';
import { LIVE_MEDPLUM_ENABLED, LIVE_TENANT, type LiveMedplum, connectLiveMedplum } from '../support/live-medplum.js';

/**
 * The SchedulingSystem contract against the real Medplum sandbox (`Mujeb-MVP`, synthetic data seeded by
 * `npm run seed:medplum -- --apply`). Opt-in and never part of `npm test`:
 *
 *   MUJEEB_LIVE_MEDPLUM=1 MEDPLUM_CLIENT_ID=… MEDPLUM_CLIENT_SECRET=… npx vitest run --config vitest.live.config.ts tests/live/medplum-contract.live.test.ts
 *
 * Reads use the seeded scenarios; writes use patients the contract registers itself (the seeded
 * appointments are never changed), and every booking is cancelled when its test ends.
 */

let live: Promise<LiveMedplum> | undefined;
const connect = (): Promise<LiveMedplum> => (live ??= connectLiveMedplum());

if (LIVE_MEDPLUM_ENABLED) {
  describeSchedulingContract('medplum sandbox (live)', async (): Promise<SchedulingContractFixture> => {
    const m = await connect();
    return {
      system: m.guarded,
      dataset: m.dataset,
      anchorDate: m.anchorDate,
      now: () => new Date(),
      ctx: m.ctx,
      foreignCtx: () => ({ tenant: { tenantId: 'other-clinic', agentId: 'x' }, signal: AbortSignal.timeout(30_000) }),
      persistent: true,
    };
  });

  describe('medplum sandbox (live): connection', () => {
    it('reports rejected credentials as a non-retryable auth error', async () => {
      const { MedplumClient } = await import('../../src/adapters/medplum/client.js');
      const m = await connect();
      const client = new MedplumClient({ baseUrl: m.settings.medplum.baseUrl, clientId: m.settings.medplum.clientId ?? '', clientSecret: 'wrong-secret' });
      await expect(client.read('Patient', [['_summary', 'count']], AbortSignal.timeout(30_000))).rejects.toMatchObject({ name: 'ProviderError', kind: 'auth', retryable: false });
    });
  });

  afterAll(async () => {
    if (!live) return;
    const m = await live;
    const result = await m.cleanup();
    process.stdout.write(`\n[live] contract cleanup: ${result.cancelled} leftover appointment(s) cancelled, ${result.failed} failed; tenant ${LIVE_TENANT.tenantId}\n`);
  });
} else {
  describe.skip('medplum sandbox (live): set MUJEEB_LIVE_MEDPLUM=1 and Medplum credentials to run', () => {
    it('skipped', () => undefined);
  });
}
