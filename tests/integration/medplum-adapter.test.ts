import { describe, expect, it } from 'vitest';
import { MedplumClient, describePath } from '../../src/adapters/medplum/client.js';
import { CANCELLATION_REASON_SYSTEM } from '../../src/adapters/medplum/fhir-schemas.js';
import { IDEMPOTENCY_KEY_SYSTEM, MedplumSchedulingSystem } from '../../src/adapters/medplum/medplum-scheduling.js';
import { CancelledError, ProviderError, SchedulingError } from '../../src/core/errors.js';
import type { LogFields, Logger } from '../../src/core/logger.js';
import { phoneSearchForms } from '../../src/core/phone.js';
import type { AvailableSlot, SchedulingContext } from '../../src/ports/scheduling.js';
import { FakeMedplum, HANG, bundle, findReply, outcome, proposed, stored, withDirectory } from '../support/fake-medplum.js';

/**
 * The Medplum adapter against recorded-shape fixtures (no network, no Medplum account). What is pinned
 * here: the requests we send (auth, parameters, bodies), how documented responses are read, and how
 * refusals/failures map to SchedulingError vs ProviderError.
 */

const NOW = Date.parse('2026-10-11T05:00:00Z');
const NATIONAL_ID_SYSTEM = 'urn:test:national-id';
const SECRET = 'client-secret-value';

function setup(options?: { ttlMs?: number }) {
  const server = withDirectory(new FakeMedplum());
  const lines: { event: string; fields: LogFields }[] = [];
  const log: Logger = {
    debug: () => {},
    info: (event, fields) => lines.push({ event, fields: fields ?? {} }),
    warn: (event, fields) => lines.push({ event, fields: fields ?? {} }),
    error: (event, fields) => lines.push({ event, fields: fields ?? {} }),
    child: () => log,
  };
  let clock = NOW;
  const client = new MedplumClient({ baseUrl: 'https://medplum.test', clientId: 'client-id', clientSecret: SECRET, fetch: server.fetch, log, retryDelayMs: 1, now: () => clock });
  const system = new MedplumSchedulingSystem({ tenantId: 'demo', client, nationalIdSystem: NATIONAL_ID_SYSTEM, directoryTtlMs: options?.ttlMs ?? 60_000, now: () => new Date(clock) });
  const ctx = (signal: AbortSignal = new AbortController().signal): SchedulingContext => ({ tenant: { tenantId: 'demo', agentId: 'a' }, signal });
  return { server, client, system, ctx, lines, advance: (ms: number) => (clock += ms) };
}

const caught = (p: Promise<unknown>) => p.then(() => undefined, (e: unknown) => e);

/** A slot as the adapter would have produced it from `$find` (keeps tests independent of ordering). */
async function slotFor(t: ReturnType<typeof setup>, serviceId: string, practitionerId: string, start: string, scheduleIds: string[], minutes = 20): Promise<AvailableSlot> {
  t.server.on('GET', /^Appointment\/\$find$/, () => ({ status: 200, body: findReply([proposed(scheduleIds, practitionerId, serviceId, start, minutes)]) }));
  const { slots } = await t.system.findAvailability(t.ctx(), { serviceId, practitionerIds: [practitionerId], from: new Date(NOW), to: new Date(NOW + 86_400_000), limit: 5 });
  if (!slots[0]) throw new Error('no slot');
  return slots[0];
}

describe('MedplumClient — authentication, retries, errors', () => {
  it('gets a client-credentials token, sends it as a bearer token, reuses it, and refreshes it before expiry', async () => {
    const t = setup();
    await t.system.searchDirectory(t.ctx(), { kind: 'any', limit: 5 });
    expect(t.server.tokenRequests).toHaveLength(1);
    expect(Object.fromEntries(t.server.tokenRequests[0] ?? [])).toEqual({ grant_type: 'client_credentials', client_id: 'client-id', client_secret: SECRET });
    expect(t.server.calls.every((c) => c.headers.get('authorization') === 'Bearer token-1')).toBe(true);
    await t.client.read('Patient/p1', [], t.ctx().signal).catch(() => undefined);
    expect(t.server.tokenRequests).toHaveLength(1);
    t.advance(3600_000 - 30_000); // inside the refresh margin
    await t.client.read('Patient/p1', [], t.ctx().signal).catch(() => undefined);
    expect(t.server.tokenRequests).toHaveLength(2);
  });

  it('shares one token request between concurrent calls', async () => {
    const t = setup();
    t.server.on('GET', /^Patient\//, () => ({ status: 200, body: { resourceType: 'Patient', id: 'p' } }));
    await Promise.all([1, 2, 3].map((n) => t.client.read(`Patient/p${n}`, [], t.ctx().signal)));
    expect(t.server.tokenRequests).toHaveLength(1);
  });

  it('refreshes the token once on 401 and repeats the request; a second 401 is an auth failure', async () => {
    const t = setup();
    t.server.sequence('GET', /^Patient\/p1$/, [{ status: 401 }, { status: 200, body: { resourceType: 'Patient', id: 'p1' } }]);
    await expect(t.client.read('Patient/p1', [], t.ctx().signal)).resolves.toMatchObject({ id: 'p1' });
    expect(t.server.tokenRequests).toHaveLength(2);
    t.server.on('GET', /^Patient\/p2$/, () => ({ status: 401 }));
    const error = await caught(t.client.read('Patient/p2', [], t.ctx().signal));
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ kind: 'auth', retryable: false });
  });

  it('reports rejected client credentials as auth, without echoing the secret', async () => {
    const t = setup();
    t.server.tokenReply = () => ({ status: 401, body: { error: 'invalid_client' } });
    const error = await caught(t.system.searchDirectory(t.ctx(), { kind: 'any', limit: 5 }));
    expect(error).toMatchObject({ name: 'ProviderError', kind: 'auth', retryable: false });
    expect(String((error as Error).message)).not.toContain(SECRET);
    expect(JSON.stringify(t.lines)).not.toContain(SECRET);
  });

  it('retries a read once after a transient failure, but never retries a write', async () => {
    const t = setup();
    t.server.sequence('GET', /^Patient\/p1$/, [{ status: 503 }, { status: 200, body: { resourceType: 'Patient', id: 'p1' } }]);
    await expect(t.client.read('Patient/p1', [], t.ctx().signal)).resolves.toMatchObject({ id: 'p1' });
    expect(t.server.fhir('GET', /^Patient\/p1$/)).toHaveLength(2);

    t.server.on('GET', /^Patient\/p2$/, () => ({ status: 503 }));
    await expect(t.client.read('Patient/p2', [], t.ctx().signal)).rejects.toMatchObject({ kind: 'unavailable' });
    expect(t.server.fhir('GET', /^Patient\/p2$/)).toHaveLength(2);

    t.server.on('GET', /^Patient\/p3$/, () => ({ status: 400, body: outcome('bad search') }));
    await expect(t.client.read('Patient/p3', [], t.ctx().signal)).rejects.toBeInstanceOf(SchedulingError);
    expect(t.server.fhir('GET', /^Patient\/p3$/)).toHaveLength(1);

    t.server.on('POST', /^Appointment\/\$book$/, () => ({ status: 503 }));
    await expect(t.client.write('POST', 'Appointment/$book', {}, t.ctx().signal)).rejects.toMatchObject({ name: 'ProviderError', kind: 'unavailable' });
    expect(t.server.fhir('POST', /^Appointment\/\$book$/)).toHaveLength(1);
  });

  it('rejects unreadable or unexpected responses as bad_response', async () => {
    const t = setup();
    t.server.on('GET', /^Appointment\/a1$/, () => ({ status: 200, raw: '{not json' }));
    await expect(t.system.getAppointment(t.ctx(), 'a1')).rejects.toMatchObject({ kind: 'bad_response' });
    t.server.on('GET', /^Appointment\/a2$/, () => ({ status: 200, body: { resourceType: 'Patient', id: 'x' } }));
    await expect(t.system.getAppointment(t.ctx(), 'a2')).rejects.toMatchObject({ kind: 'bad_response' });
    const valid = stored('a3', { patientId: 'p', practitionerId: 'pr-fahad', serviceId: 'hs-family', start: '2026-10-13T14:00:00Z', minutes: 20 });
    t.server.on('GET', /^Appointment\/a3$/, () => ({ status: 200, body: { ...valid, start: 'soon' } }));
    await expect(t.system.getAppointment(t.ctx(), 'a3')).rejects.toMatchObject({ kind: 'bad_response' });
  });

  it('aborts a hung request with the caller’s reason, and logs no IDs, identifiers or query strings', async () => {
    const t = setup();
    t.server.on('GET', /^Patient$/, () => HANG);
    const controller = new AbortController();
    const pending = t.system.findPatients(t.ctx(controller.signal), { nationalId: '1000000100' });
    setTimeout(() => controller.abort(new CancelledError('timeout_test')), 20);
    await expect(pending).rejects.toBeInstanceOf(CancelledError);
    t.server.on('GET', /^Appointment\/appt-123$/, () => ({ status: 404, body: outcome('Not found', 'not-found') }));
    await caught(t.system.getAppointment(t.ctx(), 'appt-123'));
    const logged = JSON.stringify(t.lines);
    expect(logged).not.toMatch(/1000000100|appt-123|identifier=/);
    expect(t.lines.map((l) => l.fields['operation'])).toContain('Appointment/:id');
  });

  it('describes request paths for logs without IDs', () => {
    expect(describePath('Appointment/a-123/$cancel')).toBe('Appointment/:id/$cancel');
    expect(describePath('Appointment/$find')).toBe('Appointment/$find');
    expect(describePath('')).toBe('(transaction)');
  });

  it('follows paging links only within the FHIR server', async () => {
    const t = setup();
    await expect(t.client.readLink('https://evil.test/fhir/R4/Patient?x=1', t.ctx().signal)).rejects.toMatchObject({ kind: 'bad_response' });
    t.server.on('GET', /^Patient$/, (call) => ({ status: 200, body: bundle([{ resourceType: 'Patient', id: `page-${call.query.get('page') ?? '1'}` }]) }));
    await expect(t.client.readLink('https://medplum.test/fhir/R4/Patient?page=2', t.ctx().signal)).resolves.toMatchObject({ entry: [{ resource: { id: 'page-2' } }] });
  });
});

describe('MedplumSchedulingSystem — directory and availability', () => {
  it('builds the directory from services, schedules and practitioners, searches it in Arabic, and caches it', async () => {
    const t = setup({ ttlMs: 60_000 });
    const derm = await t.system.searchDirectory(t.ctx(), { text: 'الجلديه', kind: 'any', limit: 5 });
    expect(derm.entries.map((e) => (e.kind === 'service' ? `service:${e.service.name}` : `practitioner:${e.practitioner.name}`))).toEqual(['service:الجلدية', 'practitioner:سارة الغامدي']);
    const peds = await t.system.searchDirectory(t.ctx(), { kind: 'practitioner', serviceId: 'hs-peds', limit: 5 });
    expect(peds.entries).toMatchObject([
      { practitioner: { id: 'pr-khalid', gender: 'male', services: [{ id: 'hs-peds', name: 'طب الأطفال' }] } },
      { practitioner: { id: 'pr-reem', gender: 'female' } },
    ]);
    const reem = await t.system.searchDirectory(t.ctx(), { text: 'Reem', kind: 'practitioner', limit: 5 });
    expect(reem.entries[0]).toMatchObject({ practitioner: { id: 'pr-reem' } });
    expect(t.server.fhir('GET', /^Schedule$/)).toHaveLength(1); // cached
    expect(t.server.fhir('GET', /^Practitioner$/)[0]?.query.get('_id')?.split(',').sort()).toEqual(['pr-fahad', 'pr-khalid', 'pr-reem', 'pr-sara']);
    t.advance(61_000);
    await t.system.searchDirectory(t.ctx(), { kind: 'any', limit: 5 });
    expect(t.server.fhir('GET', /^Schedule$/)).toHaveLength(2); // TTL expired → reloaded
    await expect(t.system.searchDirectory(t.ctx(), { kind: 'practitioner', serviceId: 'hs-unknown', limit: 5 })).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('runs one $find per schedule (never several schedules in one call), then merges, sorts and limits', async () => {
    const t = setup();
    t.server.on('GET', /^Appointment\/\$find$/, (call) => {
      const scheduleId = call.query.get('schedule');
      const list =
        scheduleId === 'Schedule/sch-khalid'
          ? [proposed(['sch-khalid'], 'pr-khalid', 'hs-peds', '2026-10-11T06:20:00.000Z', 20), proposed(['sch-khalid'], 'pr-khalid', 'hs-peds', '2026-10-11T06:00:00.000Z', 20)]
          : [proposed(['sch-reem'], 'pr-reem', 'hs-peds', '2026-10-11T13:00:00.000Z', 20)];
      return { status: 200, body: findReply(list) };
    });
    const from = new Date('2026-10-11T05:30:00Z');
    const result = await t.system.findAvailability(t.ctx(), { serviceId: 'hs-peds', from, to: new Date('2026-10-18T05:30:00Z'), limit: 2 });
    const finds = t.server.fhir('GET', /^Appointment\/\$find$/);
    expect(finds).toHaveLength(2);
    for (const f of finds) {
      expect(f.query.getAll('schedule')).toHaveLength(1);
      expect(Object.fromEntries([...f.query].filter(([k]) => k !== 'schedule'))).toEqual({
        start: from.toISOString(),
        end: '2026-10-18T05:50:00.000Z', // `to` + one slot (20 min): $find returns only slots that end inside the window
        'service-type-reference': 'HealthcareService/hs-peds',
        _count: '3',
      });
    }
    expect(result.slots.map((s) => [s.start.toISOString(), s.practitionerName])).toEqual([
      ['2026-10-11T06:00:00.000Z', 'خالد الشهري'],
      ['2026-10-11T06:20:00.000Z', 'خالد الشهري'],
    ]);
    expect(result.hasMore).toBe(true);
    expect(result.slots[0]?.serviceName).toBe('طب الأطفال');
  });

  it('offers slots that start inside the window even if they end after it (live: $find returns only slots that end inside)', async () => {
    const t = setup();
    // Like the real $find: 30-minute grid from 09:00 Riyadh, only slots fitting entirely inside [start, end].
    t.server.on('GET', /^Appointment\/\$find$/, (call) => {
      const start = Date.parse(call.query.get('start') ?? '');
      const end = Date.parse(call.query.get('end') ?? '');
      const grid = Array.from({ length: 8 }, (_, i) => Date.parse('2026-10-12T06:00:00Z') + i * 30 * 60_000);
      const fitting = grid.filter((s) => s >= start && s + 30 * 60_000 <= end);
      return { status: 200, body: findReply(fitting.map((s) => proposed(['sch-sara'], 'pr-sara', 'hs-derm', new Date(s).toISOString(), 30))) };
    });
    const at = (iso: string) => new Date(iso);
    const starts = async (from: string, to: string) =>
      (await t.system.findAvailability(t.ctx(), { serviceId: 'hs-derm', from: at(from), to: at(to), limit: 10 })).slots.map((s) => s.start.toISOString());
    expect(await starts('2026-10-12T07:00:00Z', '2026-10-12T07:01:00Z')).toEqual(['2026-10-12T07:00:00.000Z']);
    expect(await starts('2026-10-12T07:00:00Z', '2026-10-12T08:15:00Z')).toEqual(['2026-10-12T07:00:00.000Z', '2026-10-12T07:30:00.000Z', '2026-10-12T08:00:00.000Z']);
    expect(await starts('2026-10-12T07:01:00Z', '2026-10-12T07:30:00Z')).toEqual([]);
    expect(t.server.fhir('GET', /^Appointment\/\$find$/)[0]?.query.get('end')).toBe('2026-10-12T07:31:00.000Z'); // `to` + one 30-minute slot
  });

  it('passes ignore-appointment when rescheduling, and validates the query before calling Medplum', async () => {
    const t = setup();
    t.server.on('GET', /^Appointment\/appt-1$/, () => ({ status: 200, body: stored('appt-1', { patientId: 'p', practitionerId: 'pr-fahad', serviceId: 'hs-family', start: '2026-10-13T14:00:00Z', minutes: 20 }) }));
    t.server.on('GET', /^Appointment\/\$find$/, () => ({ status: 200, body: findReply([]) }));
    await t.system.findAvailability(t.ctx(), { serviceId: 'hs-family', from: new Date(NOW), to: new Date(NOW + 86_400_000), limit: 5, ignoreAppointmentId: 'appt-1' });
    expect(t.server.fhir('GET', /^Appointment\/\$find$/)[0]?.query.get('ignore-appointment')).toBe('Appointment/appt-1');

    const before = t.server.calls.length;
    await expect(t.system.findAvailability(t.ctx(), { serviceId: 'hs-family', from: new Date(NOW), to: new Date(NOW + 15 * 86_400_000), limit: 5 })).rejects.toMatchObject({ kind: 'invalid_request' });
    await expect(t.system.findAvailability(t.ctx(), { serviceId: 'hs-family', practitionerIds: ['pr-sara'], from: new Date(NOW), to: new Date(NOW + 86_400_000), limit: 5 })).rejects.toMatchObject({ kind: 'invalid_request' });
    await expect(t.system.findAvailability(t.ctx(), { serviceId: 'hs-family', practitionerIds: ['pr-ghost'], from: new Date(NOW), to: new Date(NOW + 86_400_000), limit: 5 })).rejects.toMatchObject({ kind: 'not_found' });
    expect(t.server.fhir('GET', /^Appointment\/\$find$/)).toHaveLength(1);
    expect(t.server.calls.length).toBe(before);
  });
});

describe('MedplumSchedulingSystem — patients', () => {
  const patient = (id: string, nationalId: string, phone: string, birthDate: string) => ({
    resourceType: 'Patient',
    id,
    name: [{ text: 'هيا فهد الزهراني', given: ['هيا'], family: 'فهد الزهراني' }],
    birthDate,
    gender: 'female',
    telecom: [{ system: 'phone', value: phone }],
    identifier: [{ system: NATIONAL_ID_SYSTEM, value: nationalId }],
  });

  it('searches by national ID system and phone, maps the record, and keeps only exact matches', async () => {
    const t = setup();
    t.server.on('GET', /^Patient$/, () => ({ status: 200, body: bundle([patient('p1', '1000000300', '+966500000103', '1992-11-20'), patient('p2', '1000000999', '+966500000103', '1992-11-20')]) }));
    const found = await t.system.findPatients(t.ctx(), { nationalId: '1000000300', phone: '+966500000103' });
    const query = t.server.fhir('GET', /^Patient$/)[0]?.query;
    expect(query?.get('identifier')).toBe(`${NATIONAL_ID_SYSTEM}|1000000300`);
    expect(query?.get('phone')).toBe(phoneSearchForms('+966500000103').join(',')); // the stored spellings, ORed in one search
    expect(found).toEqual([{ id: 'p1', fullName: 'هيا فهد الزهراني', firstName: 'هيا', birthDate: '1992-11-20', gender: 'female', nationalId: '1000000300', phone: '+966500000103' }]);
    await expect(t.system.findPatients(t.ctx(), { phone: '0500000103' })).rejects.toMatchObject({ kind: 'invalid_request' });
  });

  it('finds patients whose phone is stored in any spelling, on any of their phones, and nobody else', async () => {
    const t = setup();
    const withPhones = (id: string, birthDate: string, telecom: { system: string; value: string }[]) => ({ ...patient(id, `10000009${id.slice(-2)}`, '+966599999999', birthDate), telecom });
    t.server.on('GET', /^Patient$/, () => ({
      status: 200,
      body: bundle([
        withPhones('p-local', '1992-11-20', [{ system: 'phone', value: '0500000103' }]),
        withPhones('p-grouped', '2020-05-09', [{ system: 'phone', value: '+966 50 000 0103' }]),
        withPhones('p-second', '1980-01-01', [{ system: 'phone', value: '0112345678' }, { system: 'phone', value: '٠٥٠٠٠٠٠١٠٣' }]),
        withPhones('p-trunk', '1981-01-01', [{ system: 'phone', value: '+966 0500000103' }]),
        withPhones('p-other', '1990-01-01', [{ system: 'phone', value: '0500000104' }]), // a server may return more than asked
        withPhones('p-email', '1990-01-01', [{ system: 'email', value: '0500000103' }]),
      ]),
    }));
    const found = await t.system.findPatients(t.ctx(), { phone: '+966500000103' });
    expect(found.map((p) => p.id).sort()).toEqual(['p-grouped', 'p-local', 'p-second', 'p-trunk']);
    expect(found.every((p) => p.phone === '+966500000103')).toBe(true); // reported in canonical form
    expect(t.server.fhir('GET', /^Patient$/)).toHaveLength(1); // one bounded search, no scan
  });

  it('registers with a conditional create: 201 → new record, 200 → already_exists unless it is our own replay', async () => {
    const t = setup();
    const request = { patient: { fullName: 'ريان سعيد الشمري', nationalId: '1000000700', phone: '+966500000107', birthDate: '1999-09-09', gender: 'male' as const }, idempotencyKey: 'key-1' };
    t.server.sequence('POST', /^Patient$/, [
      { status: 201, body: { resourceType: 'Patient', id: 'new-1', ...patientBody(request.patient, 'key-1') } },
      { status: 200, body: { resourceType: 'Patient', id: 'new-1', ...patientBody(request.patient, 'key-1') } },
      { status: 200, body: { resourceType: 'Patient', id: 'old-9', ...patientBody(request.patient, 'someone-else') } },
    ]);
    await expect(t.system.registerPatient(t.ctx(), request)).resolves.toMatchObject({ id: 'new-1', firstName: 'ريان', nationalId: '1000000700' });
    const post = t.server.fhir('POST', /^Patient$/)[0];
    expect(post?.headers.get('if-none-exist')).toBe(`identifier=${encodeURIComponent(NATIONAL_ID_SYSTEM)}|1000000700`);
    expect(post?.body).toMatchObject({
      resourceType: 'Patient',
      birthDate: '1999-09-09',
      telecom: [{ system: 'phone', value: '+966500000107' }],
      identifier: [{ system: NATIONAL_ID_SYSTEM, value: '1000000700' }, { system: IDEMPOTENCY_KEY_SYSTEM, value: 'key-1' }],
    });
    await expect(t.system.registerPatient(t.ctx(), request)).resolves.toMatchObject({ id: 'new-1' }); // replay of our own create
    await expect(t.system.registerPatient(t.ctx(), request)).rejects.toMatchObject({ kind: 'already_exists' });
  });

  function patientBody(p: { fullName: string; nationalId: string; phone: string; birthDate: string }, key: string) {
    return {
      name: [{ text: p.fullName, given: [p.fullName.split(' ')[0]] }],
      birthDate: p.birthDate,
      telecom: [{ system: 'phone', value: p.phone }],
      identifier: [{ system: NATIONAL_ID_SYSTEM, value: p.nationalId }, { system: IDEMPOTENCY_KEY_SYSTEM, value: key }],
    };
  }
});

describe('MedplumSchedulingSystem — appointments', () => {
  it('reads an appointment (participants, service, version) and maps 404 to not_found', async () => {
    const t = setup();
    t.server.on('GET', /^Appointment\/a1$/, () => ({ status: 200, body: stored('a1', { patientId: 'p1', practitionerId: 'pr-sara', serviceId: 'hs-derm', start: '2026-10-15T07:00:00Z', minutes: 30, version: '4' }) }));
    await expect(t.system.getAppointment(t.ctx(), 'a1')).resolves.toEqual({
      id: 'a1',
      patientId: 'p1',
      serviceId: 'hs-derm',
      serviceName: 'الجلدية',
      practitionerId: 'pr-sara',
      practitionerName: 'سارة الغامدي',
      practitionerGender: 'female',
      start: new Date('2026-10-15T07:00:00Z'),
      end: new Date('2026-10-15T07:30:00Z'),
      status: 'booked',
      version: '4',
    });
    t.server.on('GET', /^Appointment\/nope$/, () => ({ status: 404, body: outcome('Not found', 'not-found') }));
    await expect(t.system.getAppointment(t.ctx(), 'nope')).rejects.toMatchObject({ name: 'SchedulingError', kind: 'not_found' });
  });

  it('lists a patient’s upcoming appointments with a date/status search, and not_found for an unknown patient', async () => {
    const t = setup();
    t.server.on('GET', /^Patient\/p1$/, () => ({ status: 200, body: { resourceType: 'Patient', id: 'p1' } }));
    t.server.on('GET', /^Appointment$/, () => ({
      status: 200,
      body: bundle([
        stored('a2', { patientId: 'p1', practitionerId: 'pr-fahad', serviceId: 'hs-family', start: '2026-10-15T15:20:00Z', minutes: 20 }),
        stored('a1', { patientId: 'p1', practitionerId: 'pr-sara', serviceId: 'hs-derm', start: '2026-10-15T07:00:00Z', minutes: 30 }),
      ]),
    }));
    const list = await t.system.listAppointments(t.ctx(), { patientId: 'p1' });
    expect(list.map((a) => a.id)).toEqual(['a1', 'a2']);
    const query = t.server.fhir('GET', /^Appointment$/)[0]?.query;
    expect([query?.get('patient'), query?.get('date'), query?.get('status'), query?.get('_sort')]).toEqual(['Patient/p1', `ge${new Date(NOW).toISOString()}`, 'booked,pending', 'date']);
    t.server.on('GET', /^Patient\/ghost$/, () => ({ status: 404, body: outcome('Not found', 'not-found') }));
    await expect(t.system.listAppointments(t.ctx(), { patientId: 'ghost' })).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('books with $book: sends the proposed Appointment with the patient added, and reads the Bundle answer', async () => {
    const t = setup();
    const start = '2026-10-11T13:00:00.000Z';
    const slot = await slotFor(t, 'hs-family', 'pr-fahad', start, ['sch-fahad']);
    t.server.on('GET', /^Patient\/p5$/, () => ({ status: 200, body: { resourceType: 'Patient', id: 'p5' } }));
    t.server.on('POST', /^Appointment\/\$book$/, () => ({
      status: 201,
      body: {
        resourceType: 'Bundle',
        type: 'transaction-response',
        entry: [
          { resource: { resourceType: 'Slot', id: 's-9', status: 'busy', schedule: { reference: 'Schedule/sch-fahad' }, start, end: '2026-10-11T13:20:00.000Z' } },
          { resource: stored('new-appt', { patientId: 'p5', practitionerId: 'pr-fahad', serviceId: 'hs-family', start, minutes: 20 }) },
        ],
      },
    }));
    const booked = await t.system.book(t.ctx(), { patientId: 'p5', slot, idempotencyKey: 'ses:C1:abc' });
    expect(booked).toMatchObject({ id: 'new-appt', status: 'booked', patientId: 'p5', practitionerName: 'فهد العتيبي' });
    const body = t.server.fhir('POST', /^Appointment\/\$book$/)[0]?.body as { parameter: { name: string; resource: Record<string, unknown> }[] };
    const appointment = body.parameter[0]?.resource;
    expect(body.parameter[0]?.name).toBe('appointment');
    expect(appointment).toMatchObject({ resourceType: 'Appointment', status: 'proposed', start, contained: [{ resourceType: 'Slot', schedule: { reference: 'Schedule/sch-fahad' } }] });
    expect(appointment?.['participant']).toEqual([
      { actor: { reference: 'Practitioner/pr-fahad' }, required: 'required', status: 'needs-action' },
      { actor: { reference: 'Patient/p5' }, required: 'required', status: 'accepted' },
    ]);
    expect(appointment?.['identifier']).toEqual([{ system: IDEMPOTENCY_KEY_SYSTEM, value: 'ses:C1:abc' }]);
  });

  it('maps a taken time to slot_unavailable, a server failure to an ambiguous ProviderError, and an answer without Appointment to bad_response', async () => {
    const t = setup();
    const slot = await slotFor(t, 'hs-family', 'pr-fahad', '2026-10-11T13:00:00.000Z', ['sch-fahad']);
    t.server.on('GET', /^Patient\/p5$/, () => ({ status: 200, body: { resourceType: 'Patient', id: 'p5' } }));
    t.server.sequence('POST', /^Appointment\/\$book$/, [
      { status: 400, body: outcome('Requested time slot is not available') },
      { status: 500, body: outcome('internal') },
      { status: 201, body: { resourceType: 'Bundle', type: 'transaction-response', entry: [{ resource: { resourceType: 'Slot', id: 's' } }] } },
    ]);
    const book = () => t.system.book(t.ctx(), { patientId: 'p5', slot, idempotencyKey: 'k' });
    await expect(book()).rejects.toMatchObject({ name: 'SchedulingError', kind: 'slot_unavailable' });
    const failure = await caught(book());
    expect(failure).toBeInstanceOf(ProviderError);
    expect(failure).toMatchObject({ kind: 'unavailable' });
    await expect(book()).rejects.toMatchObject({ name: 'ProviderError', kind: 'bad_response' });
    expect(t.server.fhir('POST', /^Appointment\/\$book$/)).toHaveLength(3); // one POST per attempt, never retried
  });

  it('refuses a forged slot and an unknown patient before writing anything', async () => {
    const t = setup();
    const slot = await slotFor(t, 'hs-family', 'pr-fahad', '2026-10-11T13:00:00.000Z', ['sch-fahad']);
    await expect(t.system.book(t.ctx(), { patientId: 'p5', slot: { ...slot, start: new Date('2026-10-11T14:00:00Z') }, idempotencyKey: 'k' })).rejects.toMatchObject({ kind: 'invalid_request' });
    t.server.on('GET', /^Patient\/ghost$/, () => ({ status: 404, body: outcome('Not found', 'not-found') }));
    await expect(t.system.book(t.ctx(), { patientId: 'ghost', slot, idempotencyKey: 'k' })).rejects.toMatchObject({ kind: 'not_found' });
    expect(t.server.fhir('POST')).toEqual([]);
  });

  it('reschedules with $reschedule: new start plus the complete destination schedule set; reads the Bundle answer', async () => {
    const t = setup();
    const newStart = '2026-10-11T14:00:00.000Z';
    // The proposed time occupies two schedules (e.g. the doctor and a room): both must be sent, or Medplum drops one.
    const slot = await slotFor(t, 'hs-family', 'pr-fahad', newStart, ['sch-fahad', 'sch-room-2']);
    t.server.on('GET', /^Appointment\/a1$/, () => ({ status: 200, body: stored('a1', { patientId: 'p1', practitionerId: 'pr-fahad', serviceId: 'hs-family', start: '2026-10-13T14:00:00Z', minutes: 20 }) }));
    t.server.on('POST', /^Appointment\/a1\/\$reschedule$/, () => ({
      status: 200,
      body: { resourceType: 'Bundle', type: 'transaction-response', entry: [{ resource: stored('a1', { patientId: 'p1', practitionerId: 'pr-fahad', serviceId: 'hs-family', start: newStart, minutes: 20, version: '2' }) }] },
    }));
    const moved = await t.system.reschedule(t.ctx(), { appointmentId: 'a1', newSlot: slot, idempotencyKey: 'k' });
    expect(moved).toMatchObject({ id: 'a1', version: '2', start: new Date(newStart) });
    expect(t.server.fhir('POST', /\$reschedule$/)[0]?.body).toEqual({
      resourceType: 'Parameters',
      parameter: [
        { name: 'start', valueDateTime: newStart },
        { name: 'schedule', valueReference: { reference: 'Schedule/sch-fahad' } },
        { name: 'schedule', valueReference: { reference: 'Schedule/sch-room-2' } },
      ],
    });
  });

  it('refuses reschedules that cannot be right before writing, and maps Medplum refusals', async () => {
    const t = setup();
    const familySlot = await slotFor(t, 'hs-family', 'pr-fahad', '2026-10-11T14:00:00.000Z', ['sch-fahad']);
    const base = { patientId: 'p1', practitionerId: 'pr-fahad', serviceId: 'hs-family', start: '2026-10-13T14:00:00Z', minutes: 20 };
    t.server.on('GET', /^Appointment\/cancelled$/, () => ({ status: 200, body: stored('cancelled', { ...base, status: 'cancelled' }) }));
    t.server.on('GET', /^Appointment\/derm$/, () => ({ status: 200, body: stored('derm', { ...base, serviceId: 'hs-derm' }) }));
    t.server.on('GET', /^Appointment\/with-room$/, () => ({ status: 200, body: stored('with-room', { ...base, extraParticipants: [{ actor: { reference: 'Location/room-1' } }] }) }));
    const reschedule = (appointmentId: string) => t.system.reschedule(t.ctx(), { appointmentId, newSlot: familySlot, idempotencyKey: 'k' });
    await expect(reschedule('cancelled')).rejects.toMatchObject({ kind: 'invalid_state' });
    await expect(reschedule('derm')).rejects.toMatchObject({ kind: 'invalid_request' });
    await expect(reschedule('with-room')).rejects.toMatchObject({ kind: 'invalid_request' });
    expect(t.server.fhir('POST')).toEqual([]);

    t.server.on('GET', /^Appointment\/a1$/, () => ({ status: 200, body: stored('a1', base) }));
    t.server.sequence('POST', /^Appointment\/a1\/\$reschedule$/, [
      { status: 400, body: outcome("Appointment cannot be rescheduled in 'cancelled' status") },
      { status: 400, body: outcome('Requested time slot is not available') },
      { status: 403, body: outcome('Forbidden') },
    ]);
    await expect(reschedule('a1')).rejects.toMatchObject({ kind: 'invalid_state' });
    await expect(reschedule('a1')).rejects.toMatchObject({ kind: 'slot_unavailable' });
    await expect(reschedule('a1')).rejects.toMatchObject({ name: 'ProviderError', kind: 'auth' });
  });

  it('cancels with $cancel (patient reason) and reads the Appointment it answers with', async () => {
    const t = setup();
    const booked = { patientId: 'p1', practitionerId: 'pr-sara', serviceId: 'hs-derm', start: '2026-10-15T07:00:00Z', minutes: 30 };
    t.server.on('GET', /^Appointment\/a[12]$/, (call) => ({ status: 200, body: stored(call.path.split('/')[1] ?? '', booked) }));
    t.server.on('POST', /^Appointment\/a1\/\$cancel$/, () => ({
      status: 200,
      body: { ...stored('a1', { patientId: 'p1', practitionerId: 'pr-sara', serviceId: 'hs-derm', start: '2026-10-15T07:00:00Z', minutes: 30, status: 'cancelled', version: '3' }), cancelationReason: { text: 'سفر' } },
    }));
    await expect(t.system.cancel(t.ctx(), { appointmentId: 'a1', reason: 'سفر', idempotencyKey: 'k' })).resolves.toMatchObject({ id: 'a1', status: 'cancelled', version: '3', cancellationReason: 'سفر' });
    expect(t.server.fhir('POST', /\$cancel$/)[0]?.body).toEqual({
      resourceType: 'Parameters',
      parameter: [{ name: 'cancelationReason', valueCodeableConcept: { coding: [{ system: CANCELLATION_REASON_SYSTEM, code: 'pat' }], text: 'سفر' } }],
    });

    t.server.sequence('POST', /^Appointment\/a2\/\$cancel$/, [
      { status: 400, body: outcome("Appointment cannot be canceled in 'cancelled' status") },
      { status: 404, body: outcome('Not found', 'not-found') },
      { status: 200, body: { resourceType: 'Bundle', entry: [] } },
    ]);
    const cancel = () => t.system.cancel(t.ctx(), { appointmentId: 'a2', idempotencyKey: 'k' });
    await expect(cancel()).rejects.toMatchObject({ kind: 'invalid_state' });
    await expect(cancel()).rejects.toMatchObject({ kind: 'not_found' });
    await expect(cancel()).rejects.toMatchObject({ kind: 'bad_response' });
  });

  it('refuses to cancel an appointment that is no longer active before writing (live: Medplum answers "Loading slots failed")', async () => {
    const t = setup();
    const base = { patientId: 'p1', practitionerId: 'pr-fahad', serviceId: 'hs-family', start: '2026-10-13T14:00:00Z', minutes: 20 };
    t.server.on('GET', /^Appointment\/gone$/, () => ({ status: 200, body: stored('gone', { ...base, status: 'cancelled', version: '2' }) }));
    t.server.on('GET', /^Appointment\/missing$/, () => ({ status: 404, body: outcome('Not found', 'not-found') }));
    // What Medplum answered live for a second $cancel: the Slots were deleted by the first one.
    t.server.on('POST', /\/\$cancel$/, () => ({ status: 400, body: outcome('Loading slots failed') }));
    await expect(t.system.cancel(t.ctx(), { appointmentId: 'gone', idempotencyKey: 'k' })).rejects.toMatchObject({ name: 'SchedulingError', kind: 'invalid_state' });
    await expect(t.system.cancel(t.ctx(), { appointmentId: 'missing', idempotencyKey: 'k' })).rejects.toMatchObject({ name: 'SchedulingError', kind: 'not_found' });
    expect(t.server.fhir('POST')).toEqual([]);
  });

  it('loads everything a write needs before writing: a directory outage fails before anything is sent', async () => {
    const t = setup({ ttlMs: 0 }); // reload the directory on every call
    const slot = await slotFor(t, 'hs-family', 'pr-fahad', '2026-10-11T13:00:00.000Z', ['sch-fahad']);
    t.server.on('GET', /^Patient\/p5$/, () => ({ status: 200, body: { resourceType: 'Patient', id: 'p5' } }));
    t.server.on('GET', /^Appointment\/a1$/, () => ({ status: 200, body: stored('a1', { patientId: 'p5', practitionerId: 'pr-fahad', serviceId: 'hs-family', start: '2026-10-13T14:00:00Z', minutes: 20 }) }));
    t.server.on('GET', /^HealthcareService$/, () => ({ status: 503 }));
    await expect(t.system.book(t.ctx(), { patientId: 'p5', slot, idempotencyKey: 'k' })).rejects.toMatchObject({ name: 'ProviderError', kind: 'unavailable' });
    await expect(t.system.reschedule(t.ctx(), { appointmentId: 'a1', newSlot: slot, idempotencyKey: 'k' })).rejects.toMatchObject({ kind: 'unavailable' });
    await expect(t.system.cancel(t.ctx(), { appointmentId: 'a1', idempotencyKey: 'k' })).rejects.toMatchObject({ kind: 'unavailable' });
    expect(t.server.fhir('POST')).toEqual([]);
  });

  it('never sends an empty status filter', async () => {
    const t = setup();
    t.server.on('GET', /^Patient\/p1$/, () => ({ status: 200, body: { resourceType: 'Patient', id: 'p1' } }));
    t.server.on('GET', /^Appointment$/, () => ({ status: 200, body: bundle([]) }));
    await t.system.listAppointments(t.ctx(), { patientId: 'p1', statuses: ['other'] });
    expect(t.server.fhir('GET', /^Appointment$/)[0]?.query.has('status')).toBe(false);
  });

  it('refuses a slot whose token does not hold a proposed appointment, with a normalized error', async () => {
    const t = setup();
    const start = new Date('2026-10-11T13:00:00Z');
    const token = Buffer.from(JSON.stringify({ v: 1, schedule: 'sch-fahad', practitioner: 'pr-fahad', service: 'hs-family', start: start.toISOString(), appointment: { resourceType: 'Appointment' } })).toString('base64url');
    const slot: AvailableSlot = { start, end: new Date(start.getTime() + 20 * 60_000), serviceId: 'hs-family', serviceName: '', practitionerId: 'pr-fahad', practitionerName: '', token };
    const error = await caught(t.system.book(t.ctx(), { patientId: 'p5', slot, idempotencyKey: 'k' }));
    expect(error).toBeInstanceOf(SchedulingError);
    expect(error).toMatchObject({ kind: 'invalid_request' });
    expect(t.server.fhir('POST')).toEqual([]);
  });

  it('accepts a $find answer that is a bare Bundle', async () => {
    const t = setup();
    t.server.on('GET', /^Appointment\/\$find$/, () => ({ status: 200, body: bundle([proposed(['sch-sara'], 'pr-sara', 'hs-derm', '2026-10-15T06:00:00.000Z', 30)]) }));
    const { slots } = await t.system.findAvailability(t.ctx(), { serviceId: 'hs-derm', from: new Date(NOW), to: new Date(NOW + 7 * 86_400_000), limit: 5 });
    expect(slots.map((s) => s.start.toISOString())).toEqual(['2026-10-15T06:00:00.000Z']);
  });

  it('serves only its own tenant', async () => {
    const t = setup();
    const error = await caught(t.system.searchDirectory({ tenant: { tenantId: 'other', agentId: 'x' }, signal: new AbortController().signal }, { kind: 'any', limit: 5 }));
    expect(error).toMatchObject({ name: 'ProviderError', kind: 'auth', retryable: false });
    expect(t.server.calls).toEqual([]);
  });
});
