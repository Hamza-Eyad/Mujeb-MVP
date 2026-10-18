import { afterAll, describe, it } from 'vitest';
import { describeAgentSchedulingScenarios } from '../contract/agent-scheduling.scenarios.js';
import { LIVE_MEDPLUM_ENABLED, type LiveMedplum, connectLiveMedplum, guardWrites } from '../support/live-medplum.js';

/**
 * Plan step 9 (§8.3): the same agent scenarios, in one run and with the same environment, on the in-memory
 * system and on the Medplum sandbox — only `MUJEEB_SCHEDULING_PROVIDER` differs. No language model is
 * called (the model is scripted). Opt-in, never part of `npm test`:
 *
 *   MUJEEB_LIVE_MEDPLUM=1 MEDPLUM_CLIENT_ID=… MEDPLUM_CLIENT_SECRET=… npx vitest run --config vitest.live.config.ts tests/live/agent-scheduling-swap.live.test.ts
 *
 * On Medplum, writes go through the live guard (only patients registered by this run), and whatever the run
 * booked is cancelled at the end.
 */

let live: Promise<LiveMedplum> | undefined;
const connect = (): Promise<LiveMedplum> => (live ??= connectLiveMedplum()); // fails clearly when the seed is missing or expired

if (LIVE_MEDPLUM_ENABLED) {
  describeAgentSchedulingScenarios('memory (live environment)', () => ({ env: { ...process.env, MUJEEB_SCHEDULING_PROVIDER: 'memory' } }));
  describeAgentSchedulingScenarios('medplum sandbox (live)', async () => {
    const m = await connect();
    return { env: { ...process.env, MUJEEB_SCHEDULING_PROVIDER: 'medplum' }, wrap: (system) => guardWrites(system, m.testPatientIds, m.ctx) };
  });

  afterAll(async () => {
    if (!live) return;
    const result = await (await live).cleanup();
    process.stdout.write(`\n[live] agent scenarios cleanup: ${result.cancelled} leftover appointment(s) cancelled, ${result.failed} failed\n`);
  });
} else {
  describe.skip('agent scenarios on Medplum (live): set MUJEEB_LIVE_MEDPLUM=1 and Medplum credentials to run', () => {
    it('skipped', () => undefined);
  });
}
