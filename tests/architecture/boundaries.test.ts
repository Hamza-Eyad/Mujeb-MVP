import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Enforces the modular-monolith dependency direction (plans/2026-10-07-phase-0-architecture-proposal.md §2).
 * Cheap, dependency-free, and runs with every `npm test`.
 */

const SRC = join(process.cwd(), 'src');
type Layer = 'core' | 'contracts' | 'ports' | 'agent' | 'voice' | 'observability' | 'config' | 'adapters' | 'app';

const ALLOWED: Record<Layer, readonly Layer[]> = {
  core: [],
  contracts: ['core'],
  ports: ['core'],
  observability: ['core'],
  config: ['core'],
  agent: ['core', 'ports', 'contracts'],
  voice: ['core', 'ports', 'agent', 'observability'],
  adapters: ['core', 'ports', 'contracts'],
  app: ['core', 'contracts', 'ports', 'agent', 'voice', 'observability', 'config', 'adapters'],
};

/** Third-party packages allowed per layer (node: builtins are always allowed). */
const PACKAGES: Record<Layer, readonly string[]> = {
  core: [],
  contracts: ['zod'],
  ports: [],
  observability: [],
  config: ['zod'],
  agent: [],
  voice: [],
  adapters: ['openai', 'ws', 'zod'],
  app: ['ws'],
};

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? files(full) : full.endsWith('.ts') ? [full] : [];
  });
}

function layerOf(file: string): Layer {
  return relative(SRC, file).split(sep)[0] as Layer;
}

const IMPORT = /(?:^|\n)\s*(?:import|export)[^'"]*?from\s+['"]([^'"]+)['"]/g;

describe('architecture boundaries', () => {
  const violations: string[] = [];
  for (const file of files(SRC)) {
    const layer = layerOf(file);
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(IMPORT)) {
      const spec = match[1] ?? '';
      const where = relative(process.cwd(), file);
      if (spec.startsWith('.')) {
        const target = layerOf(join(file, '..', spec));
        if (target !== layer && !ALLOWED[layer].includes(target)) violations.push(`${where}: ${layer} → ${target} (${spec})`);
      } else if (!spec.startsWith('node:')) {
        const pkg = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : (spec.split('/')[0] ?? spec);
        if (!PACKAGES[layer].includes(pkg)) violations.push(`${where}: ${layer} imports package '${pkg}'`);
      }
    }
  }

  it('keeps the dependency direction inward and vendor SDKs inside adapters', () => {
    expect(violations).toEqual([]);
  });

  it('keeps provider SDK names out of domain layers', () => {
    const leaks = files(SRC)
      .filter((f) => ['core', 'ports', 'agent', 'voice'].includes(layerOf(f)))
      .filter((f) => /elevenlabs|openai/i.test(readFileSync(f, 'utf8')))
      .map((f) => relative(process.cwd(), f));
    expect(leaks).toEqual([]);
  });

  it('lets only the composition root and the seed command use the Medplum adapter (DECISIONS A15)', () => {
    const medplumDir = join(SRC, 'adapters', 'medplum');
    const importers = files(SRC)
      .filter((f) => !f.startsWith(medplumDir))
      .filter((f) => [...readFileSync(f, 'utf8').matchAll(IMPORT)].some((m) => (m[1] ?? '').includes('adapters/medplum/')))
      .map((f) => relative(SRC, f).split(sep).join('/'))
      .sort();
    expect(importers).toEqual(['app/container.ts', 'app/medplum-seed-command.ts']);
  });

  it('has no hardcoded record IDs (UUIDs) in code or agent profiles', () => {
    const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
    const profileFiles = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => (statSync(join(dir, name)).isDirectory() ? profileFiles(join(dir, name)) : [join(dir, name)]));
    const offenders = [...files(SRC), ...profileFiles(join(process.cwd(), 'config', 'agents'))]
      .filter((f) => UUID.test(readFileSync(f, 'utf8')))
      .map((f) => relative(process.cwd(), f));
    expect(offenders).toEqual([]);
  });

  it('keeps scheduling-system vendors and data models out of domain layers and contracts (DECISIONS A14/A15)', () => {
    const leaks = files(SRC)
      .filter((f) => ['core', 'ports', 'agent', 'voice', 'contracts'].includes(layerOf(f)))
      .filter((f) => /medplum|fhir/i.test(readFileSync(f, 'utf8')))
      .map((f) => relative(process.cwd(), f));
    expect(leaks).toEqual([]);
  });
});
