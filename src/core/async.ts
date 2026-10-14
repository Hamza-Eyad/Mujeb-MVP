/** Small async primitives used across layers. */

/**
 * Unbounded single-consumer queue exposed as an async iterable. Used to bridge push-based sources
 * (WebSocket messages) into pull-based streams. Producers must bound what they push.
 */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly items: T[] = [];
  private waiter: { resolve: (r: IteratorResult<T>) => void; reject: (e: unknown) => void } | undefined;
  private ended = false;
  private failure: { error: Error } | undefined;

  push(item: T): void {
    if (this.ended || this.failure) return;
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = undefined;
      waiter.resolve({ value: item, done: false });
      return;
    }
    this.items.push(item);
  }

  end(): void {
    if (this.ended || this.failure) return;
    this.ended = true;
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = undefined;
      waiter.resolve({ value: undefined, done: true });
    }
  }

  /** Fails the stream immediately: buffered items are discarded (abort semantics). */
  fail(error: unknown): void {
    if (this.ended || this.failure) return;
    const failure = { error: error instanceof Error ? error : new Error(String(error)) };
    this.failure = failure;
    this.items.length = 0;
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = undefined;
      waiter.reject(failure.error);
    }
  }

  get isClosed(): boolean {
    return this.ended || this.failure !== undefined;
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const item = this.items.shift();
        if (item !== undefined) return Promise.resolve({ value: item, done: false });
        if (this.failure) return Promise.reject(this.failure.error);
        if (this.ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve, reject) => {
          this.waiter = { resolve, reject };
        });
      },
      return: () => {
        this.end();
        this.items.length = 0;
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortReason(signal));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortReason(signal));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Rejects as soon as `signal` aborts, even if `promise` never settles. */
export function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortReason(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

export function abortReason(signal: AbortSignal | undefined): Error {
  const reason: unknown = signal?.reason;
  if (reason instanceof Error) return reason;
  const err = new Error(typeof reason === 'string' ? reason : 'aborted');
  err.name = 'AbortError';
  return err;
}

/**
 * A signal that aborts when `parent` aborts or after `ms`, whichever comes first (with `onTimeout()` as
 * the reason). Pass no parent to get a pure deadline that ignores the caller's cancellation — e.g. for
 * writes that must run to completion. Call `dispose()` when done to clear the timer.
 */
export function withDeadline(parent: AbortSignal | undefined, ms: number, onTimeout: () => Error): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(onTimeout()), ms);
  const onParentAbort = (): void => controller.abort(abortReason(parent));
  if (parent?.aborted) onParentAbort();
  else parent?.addEventListener('abort', onParentAbort, { once: true });
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      parent?.removeEventListener('abort', onParentAbort);
    },
  };
}
