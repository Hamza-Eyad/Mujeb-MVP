/** Readable string for an unknown value (provider payloads): primitives as-is, objects as JSON. */
export function describeValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return value.toString();
  if (value === null || value === undefined) return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return '[unserializable]';
  }
}
