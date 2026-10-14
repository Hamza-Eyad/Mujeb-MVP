import { abortReason, raceAbort, sleep, withDeadline } from '../../core/async.js';
import { ProviderError, SchedulingError } from '../../core/errors.js';
import type { Logger } from '../../core/logger.js';
import { operationOutcomeSchema, tokenResponseSchema } from './fhir-schemas.js';

/**
 * Minimal FHIR R4 client for Medplum over the built-in `fetch` (no Medplum SDK, DECISIONS A15).
 *
 * - Auth: OAuth2 client credentials; the token is cached until shortly before it expires and refreshed
 *   by one shared request. A 401 refreshes the token and repeats the request once (the server refused
 *   it before doing anything, so this is safe for writes too).
 * - Reads (GET) are retried once after a transient failure (429, 502–504, connection error).
 * - Writes are never retried: a timeout, connection loss or 5xx may hide a committed change; the caller
 *   reconciles by reading instead.
 * - The caller's AbortSignal bounds every request; abort rejects with its reason.
 * - Errors: refusals the system answered ("slot not available", "cannot cancel") → SchedulingError;
 *   transport/system failures → ProviderError. Logs never include query strings, bodies or credentials.
 */

export const MEDPLUM = 'medplum';

export interface MedplumClientOptions {
  /** Server root, e.g. `https://api.medplum.com/`. FHIR lives under `fhir/R4/`, tokens under `oauth2/token`. */
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  fetch?: typeof fetch;
  log?: Logger;
  retryDelayMs?: number;
  tokenTimeoutMs?: number;
  /** Refresh the token this long before it expires. */
  tokenSkewMs?: number;
  now?: () => number;
}

export interface FhirResponse {
  status: number;
  json: unknown;
}

type Query = readonly (readonly [string, string])[];

const TRANSIENT_STATUS = new Set([429, 502, 503, 504]);

export class MedplumClient {
  private readonly o: Required<Omit<MedplumClientOptions, 'log'>> & { log: Logger | undefined };
  private readonly base: URL;
  private token: { value: string; expiresAt: number } | undefined;
  private tokenRequest: Promise<string> | undefined;

  constructor(options: MedplumClientOptions) {
    this.o = {
      fetch: globalThis.fetch.bind(globalThis),
      retryDelayMs: 250,
      tokenTimeoutMs: 10_000,
      tokenSkewMs: 60_000,
      now: () => Date.now(),
      ...options,
      log: options.log,
    };
    this.base = new URL(options.baseUrl.endsWith('/') ? options.baseUrl : `${options.baseUrl}/`);
  }

  /** GET a FHIR path (e.g. `Patient`, `Appointment/123`, `Appointment/$find`), retried once if transient. */
  async read(path: string, query: Query, signal: AbortSignal): Promise<unknown> {
    return (await this.request('GET', path, query, undefined, undefined, signal)).json;
  }

  /** GET a paging link from a search Bundle. Only links back into this server's FHIR base are followed. */
  async readLink(link: string, signal: AbortSignal): Promise<unknown> {
    const url = new URL(link, this.base);
    const fhirBase = new URL('fhir/R4/', this.base);
    if (url.origin !== fhirBase.origin || !url.pathname.startsWith(fhirBase.pathname)) {
      throw new ProviderError(MEDPLUM, 'bad_response', 'Paging link points outside the FHIR server');
    }
    return this.read(url.pathname.slice(fhirBase.pathname.length), [...url.searchParams.entries()], signal);
  }

  /** POST/PUT without automatic retries (beyond one repeat after a token refresh). */
  write(method: 'POST' | 'PUT', path: string, body: unknown, signal: AbortSignal, headers?: Record<string, string>): Promise<FhirResponse> {
    return this.request(method, path, [], body, headers, signal);
  }

  private async request(method: string, path: string, query: Query, body: unknown, headers: Record<string, string> | undefined, signal: AbortSignal): Promise<FhirResponse> {
    const url = new URL(`fhir/R4/${path}`, this.base);
    for (const [key, value] of query) url.searchParams.append(key, value);
    let refreshed = false;
    for (let attempt = 0; ; attempt += 1) {
      const started = performance.now();
      let response: FhirResponse;
      try {
        response = await this.send(method, url, body, headers, signal);
      } catch (err) {
        this.logRequest(method, path, 'network_error', started, attempt);
        if (method === 'GET' && attempt === 0 && err instanceof ProviderError && err.kind === 'unavailable' && !signal.aborted) {
          await sleep(this.o.retryDelayMs, signal);
          continue;
        }
        throw err;
      }
      this.logRequest(method, path, response.status, started, attempt);
      if (response.status === 401 && !refreshed) {
        refreshed = true;
        this.token = undefined;
        continue;
      }
      if (response.status >= 200 && response.status < 300) return response;
      if (method === 'GET' && attempt === 0 && TRANSIENT_STATUS.has(response.status) && !signal.aborted) {
        await sleep(this.o.retryDelayMs, signal);
        continue;
      }
      throw errorFor(response);
    }
  }

  private async send(method: string, url: URL, body: unknown, headers: Record<string, string> | undefined, signal: AbortSignal): Promise<FhirResponse> {
    const token = await this.accessToken(signal);
    let text: string;
    let status: number;
    try {
      const response = await this.o.fetch(url, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/fhir+json',
          ...(body !== undefined ? { 'content-type': 'application/fhir+json' } : {}),
          ...headers,
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal,
      });
      status = response.status;
      text = await response.text();
    } catch (err) {
      if (signal.aborted) throw abortReason(signal);
      throw new ProviderError(MEDPLUM, 'unavailable', 'Connection to the scheduling system failed', { cause: err });
    }
    if (text.trim() === '') return { status, json: undefined };
    try {
      return { status, json: JSON.parse(text) as unknown };
    } catch {
      if (status >= 200 && status < 300) throw new ProviderError(MEDPLUM, 'bad_response', `Unreadable response (HTTP ${status})`);
      return { status, json: undefined };
    }
  }

  private async accessToken(signal: AbortSignal): Promise<string> {
    if (this.token && this.o.now() < this.token.expiresAt - this.o.tokenSkewMs) return this.token.value;
    this.tokenRequest ??= this.fetchToken().finally(() => {
      this.tokenRequest = undefined;
    });
    return raceAbort(this.tokenRequest, signal);
  }

  /** One shared token request with its own deadline (not tied to a single caller's signal). */
  private async fetchToken(): Promise<string> {
    const deadline = withDeadline(undefined, this.o.tokenTimeoutMs, () => new ProviderError(MEDPLUM, 'timeout', 'Token request timed out'));
    try {
      let status: number;
      let json: unknown;
      try {
        const response = await this.o.fetch(new URL('oauth2/token', this.base), {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
          body: new URLSearchParams({ grant_type: 'client_credentials', client_id: this.o.clientId, client_secret: this.o.clientSecret }).toString(),
          signal: deadline.signal,
        });
        status = response.status;
        json = await response.json().catch(() => undefined);
      } catch (err) {
        if (deadline.signal.aborted) throw abortReason(deadline.signal);
        throw new ProviderError(MEDPLUM, 'unavailable', 'Token request failed', { cause: err });
      }
      if (status === 400 || status === 401 || status === 403) {
        throw new ProviderError(MEDPLUM, 'auth', `Client credentials were rejected (HTTP ${status})`, { retryable: false });
      }
      if (status < 200 || status >= 300) throw new ProviderError(MEDPLUM, status >= 500 ? 'unavailable' : 'bad_request', `Token request failed (HTTP ${status})`);
      const parsed = tokenResponseSchema.safeParse(json);
      if (!parsed.success) throw new ProviderError(MEDPLUM, 'bad_response', 'Token response has no access token');
      this.token = { value: parsed.data.access_token, expiresAt: this.o.now() + parsed.data.expires_in * 1000 };
      return parsed.data.access_token;
    } finally {
      deadline.dispose();
    }
  }

  private logRequest(method: string, path: string, status: number | string, started: number, attempt: number): void {
    this.o.log?.info('scheduling.request', {
      system: MEDPLUM,
      method,
      operation: describePath(path),
      status,
      attempt,
      ms: Math.round(performance.now() - started),
    });
  }
}

/** `Appointment/123/$cancel` → `Appointment/:id/$cancel`, `…/_history` kept (no IDs or query strings in logs). */
export function describePath(path: string): string {
  if (path === '') return '(transaction)';
  return path
    .split('/')
    .map((segment) => (/^[A-Z][A-Za-z]+$/.test(segment) || segment.startsWith('$') || segment === '_history' ? segment : ':id'))
    .join('/');
}

/** Maps a non-2xx response to a normalized error. */
export function errorFor(response: FhirResponse): Error {
  const { status } = response;
  const outcome = operationOutcomeSchema.safeParse(response.json);
  const issues = outcome.success ? outcome.data.issue : [];
  const text = issues
    .map((i) => i.details?.text ?? i.diagnostics ?? i.code ?? '')
    .filter((t) => t !== '')
    .join('; ')
    .slice(0, 300);
  const describe = (fallback: string): string => (text !== '' ? text : fallback);

  if (status === 401 || status === 403) return new ProviderError(MEDPLUM, 'auth', `Not authorized (HTTP ${status})`, { retryable: false });
  if (status === 429) return new ProviderError(MEDPLUM, 'rate_limit', 'Rate limited');
  if (status >= 500) return new ProviderError(MEDPLUM, 'unavailable', `Scheduling system error (HTTP ${status})`);
  if (status === 404 || issues.some((i) => i.code === 'not-found')) return new SchedulingError(MEDPLUM, 'not_found', describe('Not found'));
  if (/not available/i.test(text)) return new SchedulingError(MEDPLUM, 'slot_unavailable', text);
  if (/cannot be (canceled|cancelled|rescheduled) in/i.test(text)) return new SchedulingError(MEDPLUM, 'invalid_state', text);
  if (status === 412) return new SchedulingError(MEDPLUM, 'already_exists', describe('Precondition failed (multiple matches)'));
  if (status === 409) return new SchedulingError(MEDPLUM, 'invalid_state', describe('Conflict'));
  if (outcome.success) return new SchedulingError(MEDPLUM, 'invalid_request', describe(`Request refused (HTTP ${status})`));
  return new ProviderError(MEDPLUM, 'bad_request', `Request refused (HTTP ${status})`);
}
