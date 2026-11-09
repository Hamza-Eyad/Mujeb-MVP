import { describe, expect, it } from 'vitest';
import { type BenchResult, benchSweep, formatBenchTable, runBargeInScenario } from '../support/barge-in-bench.js';

// `npm run bench:barge-in`: the whole sweep, printed as a Markdown table. Virtual time, fake providers, no cost.
describe('barge-in bench', () => {
  it('prints the interruption parts per scenario', async () => {
    const results: BenchResult[] = [];
    for (const { scenario, timing } of benchSweep()) results.push(await runBargeInScenario(scenario, timing));
    console.log(`\n${formatBenchTable(results)}\n`);
    expect(results.length).toBeGreaterThan(0);
  });
});
