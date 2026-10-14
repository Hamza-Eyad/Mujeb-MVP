import type { LogFields, Logger } from '../core/logger.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const SECRET_KEY = /(api[_-]?key|token|secret|authorization|password|xi-api-key)/i;
const MAX_DEPTH = 5;

export interface JsonLoggerOptions {
  level: LogLevel;
  write?: (line: string) => void;
  bindings?: LogFields;
}

/** Structured JSON-lines logger. Secret-looking keys are always redacted. */
export function createJsonLogger(options: JsonLoggerOptions): Logger {
  const write = options.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  return makeLogger(options.level, write, options.bindings ?? {});
}

function makeLogger(level: LogLevel, write: (line: string) => void, bindings: LogFields): Logger {
  const emit = (recordLevel: LogLevel, event: string, fields?: LogFields): void => {
    if (LEVEL_RANK[recordLevel] < LEVEL_RANK[level]) return;
    const record = { ts: new Date().toISOString(), level: recordLevel, event, ...bindings, ...fields };
    let line: string;
    try {
      line = JSON.stringify(sanitize(record, 0));
    } catch {
      line = JSON.stringify({ ts: record.ts, level: recordLevel, event, log_error: 'unserializable_fields' });
    }
    write(line);
  };
  return {
    debug: (event, fields) => emit('debug', event, fields),
    info: (event, fields) => emit('info', event, fields),
    warn: (event, fields) => emit('warn', event, fields),
    error: (event, fields) => emit('error', event, fields),
    child: (extra) => makeLogger(level, write, { ...bindings, ...extra }),
  };
}

function sanitize(value: unknown, depth: number): unknown {
  if (value instanceof Error) return { name: value.name, message: value.message };
  if (typeof value === 'bigint') return value.toString();
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return '[depth]';
  if (Array.isArray(value)) return value.map((item) => sanitize(item, depth + 1));
  if (ArrayBuffer.isView(value)) return `[${value.byteLength} bytes]`;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = SECRET_KEY.test(key) ? '[redacted]' : sanitize(item, depth + 1);
  }
  return out;
}
