import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { type SchedulingDataset, parseSchedulingDataset } from '../contracts/scheduling-dataset.js';
import { ConfigError } from '../core/errors.js';

/** Loads and validates a synthetic scheduling dataset file (config/test-data/*.dataset.json). */
export async function loadSchedulingDataset(path: string): Promise<SchedulingDataset> {
  const file = resolve(path);
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(file, 'utf8'));
  } catch (err) {
    throw new ConfigError(`Cannot read scheduling dataset at ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
  return parseSchedulingDataset(raw);
}
