import { withDeadline } from '../../core/async.js';
import { ProviderError, SchedulingError, errorSummary } from '../../core/errors.js';
import type { Logger } from '../../core/logger.js';

/**
 * Per-session record of every write sent to the scheduling system (DECISIONS A16).
 *
 * - A write runs under its own deadline and is never cancelled by the caller interrupting or the turn ending.
 * - An ambiguous failure (timeout, connection loss, 5xx, unreadable reply) makes the outcome `unknown`;
 *   it is reconciled by reading the system — immediately, then once more later — never by retrying the write.
 * - While a write for a patient is `in_flight` or `unknown`, further writes for that patient are refused.
 */

export type WriteStatus = 'in_flight' | 'succeeded' | 'failed' | 'unknown';

export interface WriteEntry {
  readonly actionRef: string;
  readonly kind: string;
  /** `patient:<id>` or `national-id:<id>` (registration). Server-side only; never logged. */
  readonly patientKey: string;
  readonly idempotencyKey: string;
  readonly startedAt: number;
  status: WriteStatus;
  finishedAt?: number;
  errorKind?: string;
  reconcileAttempts: number;
}

/** What a read-back of the system says about a write whose outcome was unknown. */
export type ReconcileResult<T> = { applied: true; result: T } | { applied: false };

export type WriteOutcome<T> =
  | { status: 'succeeded'; result: T; reconciled: boolean }
  | { status: 'failed'; error: unknown; reconciled: boolean }
  | { status: 'unknown' };

export interface WriteSpec<T> {
  actionRef: string;
  kind: string;
  patientKey: string;
  idempotencyKey: string;
  /** Performs the write. `signal` is the write's own deadline — not the caller's turn. */
  run: (signal: AbortSignal) => Promise<T>;
  /** Reads the system to learn whether the write was applied. */
  reconcile: (signal: AbortSignal) => Promise<ReconcileResult<T>>;
}

export interface WriteLedgerOptions {
  system: string;
  writeTimeoutMs: number;
  readTimeoutMs: number;
  /** Reconciliation attempts before an outcome stays unknown for the rest of the session. */
  maxReconcileAttempts: number;
  log: Logger;
  now: () => number;
}

/** Kinds of transport failure that prove the write was not applied (the request was refused up front). */
const DEFINITIVE_PROVIDER_FAILURES: ReadonlySet<string> = new Set(['auth', 'bad_request', 'quota', 'rate_limit']);

interface Tracked {
  entry: WriteEntry;
  reconcile: (signal: AbortSignal) => Promise<ReconcileResult<unknown>>;
  done: Promise<void>;
}

export class WriteLedger {
  private readonly options: WriteLedgerOptions;
  private readonly tracked: Tracked[] = [];

  constructor(options: WriteLedgerOptions) {
    this.options = options;
  }

  /** The unresolved write (in flight or unknown) that blocks new writes for this patient, if any. */
  blocking(patientKey: string): WriteEntry | undefined {
    return this.tracked.find((t) => t.entry.patientKey === patientKey && (t.entry.status === 'in_flight' || t.entry.status === 'unknown'))?.entry;
  }

  entries(): readonly WriteEntry[] {
    return this.tracked.map((t) => ({ ...t.entry }));
  }

  /** Runs one write to completion and settles its outcome. Never throws for write failures. */
  async execute<T>(spec: WriteSpec<T>): Promise<WriteOutcome<T>> {
    const entry: WriteEntry = {
      actionRef: spec.actionRef,
      kind: spec.kind,
      patientKey: spec.patientKey,
      idempotencyKey: spec.idempotencyKey,
      startedAt: this.options.now(),
      status: 'in_flight',
      reconcileAttempts: 0,
    };
    let settle!: () => void;
    const tracked: Tracked = { entry, reconcile: spec.reconcile, done: new Promise<void>((resolve) => (settle = resolve)) };
    this.tracked.push(tracked);
    this.log('write.started', entry);
    try {
      const deadline = withDeadline(undefined, this.options.writeTimeoutMs, () => new ProviderError(this.options.system, 'timeout', `Write timed out after ${this.options.writeTimeoutMs}ms`));
      try {
        const result = await spec.run(deadline.signal);
        this.finish(entry, 'succeeded');
        return { status: 'succeeded', result, reconciled: false };
      } catch (err) {
        if (isDefinitiveFailure(err)) {
          this.finish(entry, 'failed', err);
          return { status: 'failed', error: err, reconciled: false };
        }
        entry.status = 'unknown';
        entry.errorKind = errorSummary(err).error_kind ?? errorSummary(err).error_name;
        this.log('write.outcome_unknown', entry);
      } finally {
        deadline.dispose();
      }
      const reconciled = await this.reconcileEntry(tracked);
      if (reconciled === undefined) return { status: 'unknown' };
      return reconciled.applied
        ? { status: 'succeeded', result: reconciled.result as T, reconciled: true }
        : { status: 'failed', error: new SchedulingError(this.options.system, 'invalid_state', 'Write was not applied'), reconciled: true };
    } finally {
      settle();
    }
  }

  /**
   * Retries reconciliation of unknown outcomes (for one patient, or all) that still have attempts left.
   * Returns the entries that became resolved.
   */
  async reconcileUnresolved(patientKey?: string): Promise<{ entry: WriteEntry; applied: boolean; result?: unknown }[]> {
    const resolved: { entry: WriteEntry; applied: boolean; result?: unknown }[] = [];
    for (const tracked of this.tracked) {
      const e = tracked.entry;
      if (e.status !== 'unknown' || e.reconcileAttempts >= this.options.maxReconcileAttempts) continue;
      if (patientKey !== undefined && e.patientKey !== patientKey) continue;
      const outcome = await this.reconcileEntry(tracked);
      if (outcome) resolved.push({ entry: { ...e }, applied: outcome.applied, ...(outcome.applied ? { result: outcome.result } : {}) });
    }
    return resolved;
  }

  /** Waits (bounded) for in-flight writes, e.g. before a session closes. Returns how many were still running at the deadline. */
  async drain(timeoutMs: number): Promise<number> {
    const running = this.tracked.filter((t) => t.entry.status === 'in_flight');
    if (running.length === 0) return 0;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.all(running.map((t) => t.done)),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
    clearTimeout(timer);
    const left = running.filter((t) => t.entry.status === 'in_flight').length;
    if (left > 0) this.options.log.warn('write.drain_timeout', { still_in_flight: left });
    return left;
  }

  private async reconcileEntry(tracked: Tracked): Promise<ReconcileResult<unknown> | undefined> {
    const entry = tracked.entry;
    entry.reconcileAttempts += 1;
    const deadline = withDeadline(undefined, this.options.readTimeoutMs, () => new ProviderError(this.options.system, 'timeout', 'Reconciliation read timed out'));
    try {
      const outcome = await tracked.reconcile(deadline.signal);
      this.finish(entry, outcome.applied ? 'succeeded' : 'failed');
      this.log('write.reconciled', entry, { applied: outcome.applied });
      return outcome;
    } catch (err) {
      this.log('scheduling.outcome_unresolved', entry, { reconcile_error: errorSummary(err).error_kind ?? errorSummary(err).error_name });
      return undefined;
    } finally {
      deadline.dispose();
    }
  }

  private finish(entry: WriteEntry, status: 'succeeded' | 'failed', error?: unknown): void {
    entry.status = status;
    entry.finishedAt = this.options.now();
    if (error !== undefined) entry.errorKind = errorSummary(error).error_kind ?? errorSummary(error).error_name;
    this.log(`write.${status}`, entry);
  }

  private log(event: string, entry: WriteEntry, extra?: Record<string, unknown>): void {
    const fields = {
      action_ref: entry.actionRef,
      kind: entry.kind,
      status: entry.status,
      reconcile_attempts: entry.reconcileAttempts,
      ...(entry.errorKind !== undefined ? { error_kind: entry.errorKind } : {}),
      ...(entry.finishedAt !== undefined ? { ms: entry.finishedAt - entry.startedAt } : {}),
      ...extra,
    };
    if (event === 'scheduling.outcome_unresolved' || event === 'write.outcome_unknown') this.options.log.warn(event, fields);
    else this.options.log.info(event, fields);
  }
}

/** True when the system definitely did not apply the write (a business answer, or a request refused up front). */
function isDefinitiveFailure(err: unknown): boolean {
  if (err instanceof SchedulingError) return true;
  return err instanceof ProviderError && DEFINITIVE_PROVIDER_FAILURES.has(err.kind);
}
