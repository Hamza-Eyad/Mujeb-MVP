import { describe, expect, it } from 'vitest';
import { type BenchResult, benchSweep, runBargeInScenario } from '../support/barge-in-bench.js';

// The bench's sweep on the virtual clock. These checks are about the measurement and the policy's outcomes,
// not about speed: the speed figures are findings, printed by `npm run bench:barge-in`.
describe('barge-in bench', () => {
  it('measures every scripted interruption in parts that match the known timings', async () => {
    const runs: { result: BenchResult; expect: 'interrupt' | 'ignore'; clean: boolean }[] = [];
    for (const { scenario, timing } of benchSweep()) {
      const result = await runBargeInScenario(scenario, timing);
      runs.push({ result, expect: scenario.expect, clean: scenario.noiseLeadMs === undefined && scenario.echoPrefix === undefined });
    }

    for (const { result: r, expect: expected, clean } of runs) {
      const label = `${r.scenario} first=${r.timing.firstPartialMs}/${r.timing.firstWords} lead=${r.noiseLeadMs ?? '-'}`;
      if (expected === 'ignore') {
        expect(r, label).toMatchObject({ interrupted: false, pauses: 0, falseInterruptions: 0 });
        continue;
      }
      expect(r.interrupted, label).toBe(true);
      expect(r.falseInterruptions, label).toBe(0);
      // (a) + (b) + (c) is the whole delay from the moment the caller started speaking.
      const parts = (r.vadMs ?? NaN) + (r.sttMs ?? NaN) + (r.policyMs ?? NaN);
      expect(Math.abs(parts - (r.totalMs ?? NaN)), label).toBeLessThanOrEqual(50);
      expect(r.quietMs, label).toBeLessThanOrEqual(r.totalMs ?? -1);
      if (clean) {
        expect(Math.abs(r.vadMs ?? NaN), label).toBeLessThanOrEqual(40);
        expect(Math.abs((r.sttMs ?? NaN) - r.timing.firstPartialMs), label).toBeLessThanOrEqual(40);
      }
      if (r.noiseLeadMs !== undefined) {
        // The segment measure starts at the caller's speech; the old one at the earlier burst.
        expect(Math.abs(r.vadMs ?? NaN), label).toBeLessThanOrEqual(40);
        expect(Math.abs((r.oldMs ?? NaN) - (r.totalMs ?? NaN) - r.noiseLeadMs), label).toBeLessThanOrEqual(50);
      }
    }
  });
});
