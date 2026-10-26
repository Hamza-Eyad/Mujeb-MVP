import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { type CallRoutesFile, callRoutesSchema } from '../contracts/call-routes.js';
import { ConfigError } from '../core/errors.js';

/**
 * Dialed number (or SIP address) → the clinic that answers it. Exact match only: a key that is not
 * configured is rejected, never guessed, so one clinic's calls can never open another clinic's data.
 * Phase 2 replaces the file with tenant configuration; this lookup stays.
 */
export class CallRouter<T> {
  private readonly routes: ReadonlyMap<string, T>;

  constructor(entries: Iterable<readonly [string, T]>) {
    const routes = new Map<string, T>();
    for (const [rawKey, target] of entries) {
      const key = rawKey.trim();
      if (routes.has(key)) throw new ConfigError(`Duplicate telephony route key: ${key}`);
      routes.set(key, target);
    }
    if (routes.size === 0) throw new ConfigError('No telephony routes configured');
    this.routes = routes;
  }

  get size(): number {
    return this.routes.size;
  }

  resolve(dialed: string): T | undefined {
    return this.routes.get(dialed.trim());
  }
}

/** Reads and validates the routes file (MUJEEB_TELEPHONY_ROUTES). */
export async function loadCallRoutes(path: string): Promise<CallRoutesFile> {
  const file = resolve(path);
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(file, 'utf8'));
  } catch (err) {
    throw new ConfigError(`Cannot read telephony routes at ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const parsed = callRoutesSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ConfigError(`Invalid telephony routes: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  return parsed.data;
}
