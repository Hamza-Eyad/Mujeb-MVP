import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MemorySchedulingSystem } from '../../src/adapters/fakes/memory-scheduling.js';
import { loadAgentProfile } from '../../src/app/agent-profile.js';
import { loadSchedulingDataset } from '../../src/app/scheduling-dataset.js';

/** Every clinic profile in config/agents loads, and its synthetic dataset (if any) is valid and serves its tenant. */
const PROFILES = readdirSync('config/agents', { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => join('config/agents', d.name));

describe('config/agents profiles', () => {
  it.each(PROFILES)('%s loads with its instructions and dataset', async (dir) => {
    const profile = await loadAgentProfile(dir);
    expect(profile.instructions.length).toBeGreaterThan(0);
    if (profile.schedulingDataset !== undefined) {
      const dataset = await loadSchedulingDataset(profile.schedulingDataset);
      expect(dataset.synthetic).toBe(true);
      expect(() => new MemorySchedulingSystem({ tenantId: profile.tenantId, dataset })).not.toThrow();
    }
  });

  it('the showcase clinic has every specialty its instructions name, and no leave that empties a specialty', async () => {
    const profile = await loadAgentProfile('config/agents/showcase-clinic');
    const dataset = await loadSchedulingDataset(profile.schedulingDataset ?? '');
    const names = dataset.services.map((s) => s.name);
    for (const named of ['طب الأسرة', 'الباطنية', 'طب الأطفال', 'الجلدية', 'الأسنان', 'العيون', 'النساء والولادة', 'العظام']) expect(names).toContain(named);
    expect(dataset.blocks).toEqual([]);
    for (const service of dataset.services) expect(dataset.practitioners.some((p) => p.serviceKeys.includes(service.key))).toBe(true);
  });
});
