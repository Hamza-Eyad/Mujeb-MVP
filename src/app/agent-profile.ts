import { readFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { type AgentProfile, agentProfileSchema } from '../contracts/agent-profile.js';
import { ConfigError } from '../core/errors.js';

/** Loads a local agent profile directory: `profile.json` + the instruction files it names. */
export async function loadAgentProfile(dir: string): Promise<AgentProfile> {
  const root = resolve(dir);
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(resolve(root, 'profile.json'), 'utf8'));
  } catch (err) {
    throw new ConfigError(`Cannot read agent profile at ${root}/profile.json: ${err instanceof Error ? err.message : String(err)}`);
  }
  const parsed = agentProfileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ConfigError(`Invalid agent profile: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  const { instructionsFile, appointmentTools, schedulingDataset, ...rest } = parsed.data;
  const profile = { ...rest, ...(schedulingDataset !== undefined ? { schedulingDataset: resolve(root, schedulingDataset) } : {}) };
  const instructions = await readInside(root, instructionsFile, 'instructionsFile');
  if (!appointmentTools) return { ...profile, instructions };
  const { instructionsFile: toolsFile, ...tools } = appointmentTools;
  return { ...profile, instructions, appointmentTools: { ...tools, instructions: await readInside(root, toolsFile, 'appointmentTools.instructionsFile') } };
}

/** Reads a non-empty text file that must stay inside the profile directory. */
async function readInside(root: string, file: string, field: string): Promise<string> {
  const path = resolve(root, file);
  const rel = relative(root, path);
  if (rel.startsWith('..') || resolve(root, rel) !== path) {
    throw new ConfigError(`Agent profile ${field} must stay inside the profile directory`);
  }
  const text = (await readFile(path, 'utf8')).trim();
  if (text === '') throw new ConfigError(`Agent profile ${field} is empty`);
  return text;
}
