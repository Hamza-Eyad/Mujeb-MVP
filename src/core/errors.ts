/** Normalized error types. Orchestration code never sees vendor-specific exceptions. */

export type ProviderErrorKind =
  | 'auth'
  | 'rate_limit'
  | 'quota'
  | 'timeout'
  | 'unavailable'
  | 'bad_request'
  | 'bad_response'
  | 'unknown';

const RETRYABLE: ReadonlySet<ProviderErrorKind> = new Set(['rate_limit', 'timeout', 'unavailable']);

export class ProviderError extends Error {
  readonly provider: string;
  readonly kind: ProviderErrorKind;
  readonly retryable: boolean;

  constructor(provider: string, kind: ProviderErrorKind, message: string, options?: { cause?: unknown; retryable?: boolean }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ProviderError';
    this.provider = provider;
    this.kind = kind;
    this.retryable = options?.retryable ?? RETRYABLE.has(kind);
  }
}

/**
 * Business outcome reported by a scheduling system (HIS). Transport/system failures stay
 * ProviderError; this type is for answers like "that slot is taken" that callers must handle.
 */
export type SchedulingErrorKind = 'not_found' | 'slot_unavailable' | 'invalid_state' | 'already_exists' | 'invalid_request';

export class SchedulingError extends Error {
  readonly system: string;
  readonly kind: SchedulingErrorKind;

  constructor(system: string, kind: SchedulingErrorKind, message: string, options?: { cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'SchedulingError';
    this.system = system;
    this.kind = kind;
  }
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** Reason attached to an AbortController when Mujeeb cancels work on purpose. */
export class CancelledError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`cancelled: ${reason}`);
    this.name = 'CancelledError';
    this.reason = reason;
  }
}

export function isAbortLike(err: unknown): boolean {
  return err instanceof Error && (err.name === 'AbortError' || err.name === 'CancelledError');
}

export function errorSummary(err: unknown): { error_name: string; error_kind?: string; provider?: string; message: string } {
  if (err instanceof ProviderError) {
    return { error_name: err.name, error_kind: err.kind, provider: err.provider, message: err.message };
  }
  if (err instanceof SchedulingError) {
    return { error_name: err.name, error_kind: err.kind, provider: err.system, message: err.message };
  }
  if (err instanceof Error) return { error_name: err.name, message: err.message };
  return { error_name: 'NonError', message: String(err) };
}
