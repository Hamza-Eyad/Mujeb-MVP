import { FHIR_TIMEZONE_EXTENSION, SCHEDULING_PARAMETERS_EXTENSION, SERVICE_TYPE_REFERENCE_EXTENSION } from '../../src/adapters/medplum/fhir-schemas.js';

/**
 * In-process stand-in for a Medplum server: a `fetch` that records every request and answers from routes
 * (fixtures shaped like the documented Medplum/FHIR responses). No network.
 */

export interface RecordedCall {
  method: string;
  /** Path under fhir/R4/ (e.g. `Appointment/$find`). */
  path: string;
  query: URLSearchParams;
  headers: Headers;
  body: unknown;
}

export const HANG = Symbol('hang');
export type Reply = { status: number; body?: unknown; raw?: string } | typeof HANG;

export class FakeMedplum {
  readonly calls: RecordedCall[] = [];
  readonly tokenRequests: URLSearchParams[] = [];
  tokenReply: () => Reply = () => ({ status: 200, body: { access_token: `token-${this.tokenRequests.length}`, token_type: 'Bearer', expires_in: 3600 } });
  private readonly routes: { method: string; pattern: RegExp; reply: (call: RecordedCall) => Reply }[] = [];

  /** Later routes win over earlier ones. */
  on(method: string, pattern: RegExp, reply: (call: RecordedCall) => Reply): this {
    this.routes.unshift({ method, pattern, reply });
    return this;
  }

  /** Replies in order (last one repeats). */
  sequence(method: string, pattern: RegExp, replies: Reply[]): this {
    let i = 0;
    return this.on(method, pattern, () => replies[Math.min(i++, replies.length - 1)] ?? { status: 500 });
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const signal = init?.signal ?? undefined;
    if (signal?.aborted) throw signal.reason;
    let reply: Reply;
    if (url.pathname.endsWith('/oauth2/token')) {
      this.tokenRequests.push(new URLSearchParams(typeof init?.body === 'string' ? init.body : ''));
      reply = this.tokenReply();
    } else {
      const call: RecordedCall = {
        method: init?.method ?? 'GET',
        path: url.pathname.replace(/^\/fhir\/R4\//, ''),
        query: url.searchParams,
        headers: new Headers(init?.headers),
        body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
      };
      this.calls.push(call);
      const route = this.routes.find((r) => r.method === call.method && r.pattern.test(call.path));
      reply = route ? route.reply(call) : { status: 599, body: { unrouted: `${call.method} ${call.path}` } };
    }
    if (reply === HANG) {
      return new Promise<Response>((_, reject) => signal?.addEventListener('abort', () => reject(signal.reason as Error)));
    }
    await Promise.resolve();
    return new Response(reply.raw ?? JSON.stringify(reply.body ?? null), { status: reply.status, headers: { 'content-type': 'application/fhir+json' } });
  };

  fhir(method?: string, path?: RegExp): RecordedCall[] {
    return this.calls.filter((c) => (method === undefined || c.method === method) && (path === undefined || path.test(c.path)));
  }
}

// ─────────────────────────────── fixtures ───────────────────────────────

export const bundle = (resources: unknown[], next?: string) => ({
  resourceType: 'Bundle',
  type: 'searchset',
  entry: resources.map((resource) => ({ resource })),
  ...(next ? { link: [{ relation: 'next', url: next }] } : {}),
});

export const outcome = (text: string, code = 'invalid') => ({ resourceType: 'OperationOutcome', issue: [{ severity: 'error', code, details: { text } }] });

export const service = (id: string, name: string, aliases: string[], minutes: number) => ({
  resourceType: 'HealthcareService',
  id,
  active: true,
  name,
  type: [{ text: name }],
  specialty: aliases.map((text) => ({ text })),
  extension: [{ url: SCHEDULING_PARAMETERS_EXTENSION, extension: [{ url: 'duration', valueDuration: { value: minutes, unit: 'min' } }] }],
});

export const practitioner = (id: string, name: string, gender: 'male' | 'female', aliases: string[] = []) => ({
  resourceType: 'Practitioner',
  id,
  gender,
  name: [{ text: name }, ...aliases.map((text) => ({ text, use: 'nickname' }))],
  extension: [{ url: FHIR_TIMEZONE_EXTENSION, valueCode: 'Asia/Riyadh' }],
});

export const schedule = (id: string, practitionerId: string, serviceIds: string[]) => ({
  resourceType: 'Schedule',
  id,
  active: true,
  actor: [{ reference: `Practitioner/${practitionerId}` }],
  serviceType: serviceIds.map((s) => ({ extension: [{ url: SERVICE_TYPE_REFERENCE_EXTENSION, valueReference: { reference: `HealthcareService/${s}` } }] })),
});

export const serviceType = (serviceId: string) => [
  { coding: [{ code: serviceId }], extension: [{ url: SERVICE_TYPE_REFERENCE_EXTENSION, valueReference: { reference: `HealthcareService/${serviceId}` } }] },
];

/** A proposed Appointment as `$find` returns it (not stored; contained Slot(s) for the schedule(s)). */
export const proposed = (scheduleIds: string[], practitionerId: string, serviceId: string, start: string, minutes: number) => {
  const end = new Date(Date.parse(start) + minutes * 60_000).toISOString();
  return {
    resourceType: 'Appointment',
    status: 'proposed',
    start,
    end,
    serviceType: serviceType(serviceId),
    participant: [{ actor: { reference: `Practitioner/${practitionerId}` }, required: 'required', status: 'needs-action' }],
    contained: scheduleIds.map((s, i) => ({ resourceType: 'Slot', id: `slot${i}`, status: 'busy', schedule: { reference: `Schedule/${s}` }, start, end })),
  };
};

export const findReply = (appointments: unknown[]) => ({ resourceType: 'Parameters', parameter: [{ name: 'return', resource: bundle(appointments) }] });

export const stored = (
  id: string,
  options: { patientId: string; practitionerId: string; serviceId: string; start: string; minutes: number; status?: string; version?: string; extraParticipants?: unknown[] },
) => ({
  resourceType: 'Appointment',
  id,
  meta: { versionId: options.version ?? '1' },
  status: options.status ?? 'booked',
  start: options.start,
  end: new Date(Date.parse(options.start) + options.minutes * 60_000).toISOString(),
  serviceType: serviceType(options.serviceId),
  participant: [
    { actor: { reference: `Practitioner/${options.practitionerId}`, display: 'x' }, status: 'accepted' },
    { actor: { reference: `Patient/${options.patientId}` }, status: 'accepted' },
    ...(options.extraParticipants ?? []),
  ],
  slot: [{ reference: 'Slot/s-1' }],
});

/** The demo clinic directory (same shape the seed creates). */
export const DIRECTORY = {
  services: [service('hs-family', 'طب الأسرة', ['طب عام', 'family medicine'], 20), service('hs-peds', 'طب الأطفال', ['أطفال'], 20), service('hs-derm', 'الجلدية', ['جلدية', 'dermatology'], 30)],
  practitioners: [
    practitioner('pr-fahad', 'فهد العتيبي', 'male', ['Fahad Alotaibi']),
    practitioner('pr-khalid', 'خالد الشهري', 'male'),
    practitioner('pr-reem', 'ريم القحطاني', 'female', ['Reem Alqahtani']),
    practitioner('pr-sara', 'سارة الغامدي', 'female'),
  ],
  schedules: [schedule('sch-fahad', 'pr-fahad', ['hs-family']), schedule('sch-khalid', 'pr-khalid', ['hs-peds']), schedule('sch-reem', 'pr-reem', ['hs-peds']), schedule('sch-sara', 'pr-sara', ['hs-derm'])],
};

export function withDirectory(server: FakeMedplum): FakeMedplum {
  return server
    .on('GET', /^HealthcareService$/, () => ({ status: 200, body: bundle(DIRECTORY.services) }))
    .on('GET', /^Schedule$/, () => ({ status: 200, body: bundle(DIRECTORY.schedules) }))
    .on('GET', /^Practitioner$/, (call) => {
      const ids = (call.query.get('_id') ?? '').split(',');
      return { status: 200, body: bundle(DIRECTORY.practitioners.filter((p) => ids.includes(p.id))) };
    });
}
