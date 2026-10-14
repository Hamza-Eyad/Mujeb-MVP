import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MedplumClient } from '../../src/adapters/medplum/client.js';
import { FHIR_TIMEZONE_EXTENSION, SCHEDULING_PARAMETERS_EXTENSION, SERVICE_TYPE_REFERENCE_EXTENSION } from '../../src/adapters/medplum/fhir-schemas.js';
import { MedplumSchedulingSystem } from '../../src/adapters/medplum/medplum-scheduling.js';
import { SEED_KEY_SYSTEM, SYNTHETIC_TAG, type SeedPlan, applySeedPlan, buildSeedPlan, seedAppointmentKey, seedReference } from '../../src/adapters/medplum/seed.js';
import { runSeedCommand } from '../../src/app/medplum-seed-command.js';
import { loadSettings } from '../../src/config/settings.js';
import { type SchedulingDataset, parseSchedulingDataset } from '../../src/contracts/scheduling-dataset.js';
import { ConfigError } from '../../src/core/errors.js';
import { silentLogger } from '../../src/core/logger.js';
import { instantToZoned } from '../../src/core/zoned-time.js';
import { FakeMedplum, type RecordedCall, type Reply, bundle, findReply, outcome, proposed, withDirectory } from '../support/fake-medplum.js';

const NOW = new Date('2026-10-11T05:00:00Z'); // Sunday 08:00 in Riyadh
const ANCHOR = '2026-10-11';
const NATIONAL_ID_SYSTEM = 'urn:test:national-id';
const dataset = (): SchedulingDataset => parseSchedulingDataset(JSON.parse(readFileSync('config/test-data/demo-clinic.dataset.json', 'utf8')));
const planFor = (anchor: string): SeedPlan => buildSeedPlan(dataset(), anchor, { nationalIdSystem: NATIONAL_ID_SYSTEM });
type Resource = Record<string, unknown> & { resourceType: string; id?: string };

const resourcesOf = (plan: SeedPlan, type: string) => plan.resources.filter((r) => r.resourceType === type).map((r) => r.resource);
const seedKeyOf = (r: unknown): string | undefined =>
  ((r as { identifier?: { system: string; value: string }[] }).identifier ?? []).find((i) => i.system === SEED_KEY_SYSTEM)?.value;
const BLOCK_KEY = 'block:dr-sara-leave:schedule:dr-sara:dermatology';
const APPOINTMENT_KEYS = ['appt-one', 'appt-two-a', 'appt-two-b', 'appt-child'];

describe('Medplum seed plan (dry run)', () => {
  const plan = planFor(ANCHOR);

  it('is a dependency-ordered list of conditional creates keyed by stable seed keys — no transaction, no urn:uuid', () => {
    expect(plan.counts).toEqual({ Organization: 1, Location: 1, HealthcareService: 3, Practitioner: 4, Schedule: 4, Patient: 5, 'Slot (leave block)': 1, 'Appointment (to book)': 4 });
    expect(plan.resources.map((r) => r.resourceType)).toEqual([
      'Organization',
      'Location',
      ...Array<string>(3).fill('HealthcareService'),
      ...Array<string>(4).fill('Practitioner'),
      ...Array<string>(4).fill('Schedule'),
      ...Array<string>(5).fill('Patient'),
    ]);
    const earlier = new Set<string>();
    for (const r of plan.resources) {
      expect(seedKeyOf(r.resource)).toBe(r.key);
      expect(r.resource['meta']).toEqual({ tag: [SYNTHETIC_TAG] });
      expect(r.resource['id']).toBeUndefined();
      // Every reference names an earlier resource by its seed key, and is listed as a dependency.
      const refs = [...JSON.stringify(r.resource).matchAll(/"reference":"([^"]+)"/g)].map((m) => m[1] ?? '');
      for (const ref of refs) {
        const key = /^[A-Za-z]+\?identifier=urn:mujeeb:seed-key\|(.+)$/.exec(ref)?.[1];
        expect(key).toBeDefined();
        expect(earlier.has(key ?? '')).toBe(true);
        expect(r.dependsOn).toContain(key);
      }
      earlier.add(r.key);
    }
    expect(plan.resources.find((r) => r.key === 'schedule:dr-sara:dermatology')?.dependsOn).toEqual(['practitioner:dr-sara', 'service:dermatology']);
    expect(JSON.stringify(plan)).not.toMatch(/urn:uuid|"transaction"/);
    expect(planFor(ANCHOR)).toEqual(plan); // reproducible
  });

  it('defines availability the way Medplum scheduling expects', () => {
    const [service] = resourcesOf(plan, 'HealthcareService');
    expect(service?.['extension']).toEqual([
      {
        url: SCHEDULING_PARAMETERS_EXTENSION,
        extension: [
          { url: 'duration', valueDuration: { value: 20, unit: 'min', system: 'http://unitsofmeasure.org', code: 'min' } },
          { url: 'alignmentInterval', valueDuration: { value: 20, unit: 'min', system: 'http://unitsofmeasure.org', code: 'min' } },
          { url: 'alignmentTimezone', valueCode: 'Asia/Riyadh' },
        ],
      },
    ]);
    for (const p of resourcesOf(plan, 'Practitioner')) expect(p['extension']).toEqual([{ url: FHIR_TIMEZONE_EXTENSION, valueCode: 'Asia/Riyadh' }]);

    const sara = resourcesOf(plan, 'Schedule').find((s) => JSON.stringify(s).includes('سارة الغامدي'));
    const dermatology = seedReference('HealthcareService', 'service:dermatology');
    expect(sara?.['serviceType']).toMatchObject([{ extension: [{ url: SERVICE_TYPE_REFERENCE_EXTENSION, valueReference: { reference: dermatology } }] }]);
    const params = (sara?.['extension'] as { url: string; extension: { url: string; extension?: { url: string; extension: unknown[] }[] }[] }[])[0];
    expect(params?.url).toBe(SCHEDULING_PARAMETERS_EXTENSION);
    expect(params?.extension[0]).toEqual({ url: 'service', valueReference: { reference: dermatology, display: 'الجلدية' } });
    expect(params?.extension[1]?.extension).toHaveLength(2); // morning and evening windows
    expect(params?.extension[1]?.extension?.[0]?.extension).toEqual([
      ...['sun', 'mon', 'tue', 'wed', 'thu'].map((day) => ({ url: 'daysOfWeek', valueCode: day })),
      { url: 'availableStartTime', valueTime: '09:00:00' },
      { url: 'availableEndTime', valueTime: '13:00:00' },
    ]);
  });

  it('blocks leave days as busy-unavailable time, stores patients with the national ID system, and plans bookings on working days', () => {
    expect(plan.blocks).toEqual([
      {
        key: BLOCK_KEY,
        scheduleKey: 'schedule:dr-sara:dermatology',
        startDate: '2026-10-12',
        endDate: '2026-10-14',
        start: '2026-10-11T21:00:00.000Z',
        end: '2026-10-14T21:00:00.000Z',
        reason: 'إجازة',
      },
    ]);
    // The block's seed key does not depend on the anchor day, so a later run finds and moves the same Slot.
    expect(planFor('2026-10-20').blocks.map((b) => b.key)).toEqual(plan.blocks.map((b) => b.key));
    const mother = resourcesOf(plan, 'Patient').find((p) => JSON.stringify(p).includes('هيا'));
    expect(mother).toMatchObject({ birthDate: '1992-11-20', gender: 'female', telecom: [{ system: 'phone', value: '+966500000103' }] });
    expect(mother?.['identifier']).toContainEqual({ system: NATIONAL_ID_SYSTEM, value: '1000000300' });
    for (const a of plan.appointments) {
      const local = instantToZoned(new Date(a.start), 'Asia/Riyadh');
      expect([local.date, local.time]).toEqual([a.date, a.time]);
      expect([5, 6]).not.toContain(local.weekday); // not Friday/Saturday
    }
  });

  it('writes the plan without any network call; --apply needs credentials; reset needs --apply', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'mujeeb-seed-'));
    const noNetwork: typeof fetch = () => Promise.reject(new Error('network must not be used in a dry run'));
    const settings = loadSettings({}, { forceFakeProviders: true });
    const tenant = { tenantId: 'demo', agentId: 'demo-clinic' };
    const result = await runSeedCommand(settings, tenant, silentLogger, { apply: false, resetAppointments: false, outDir, now: NOW, fetch: noNetwork });
    expect(result.report).toBeUndefined();
    const written = JSON.parse(readFileSync(result.planFile, 'utf8')) as SeedPlan;
    expect(written.counts['Patient']).toBe(5);
    expect(written.resources).toHaveLength(18);
    expect(written.anchorDate).toBe(ANCHOR);
    await expect(runSeedCommand(settings, tenant, silentLogger, { apply: true, resetAppointments: false, outDir, now: NOW, fetch: noNetwork })).rejects.toBeInstanceOf(ConfigError);
    await expect(runSeedCommand(settings, tenant, silentLogger, { apply: false, resetAppointments: true, outDir, now: NOW, fetch: noNetwork })).rejects.toThrow(/--apply/);
  });
});

/**
 * A small stateful Medplum: conditional create (`If-None-Exist`), search by identifier/_id, versioned reads
 * with `_history`, version-checked Slot updates (`If-Match`), `$find`, `$book` and `$cancel`. It rejects any
 * body that still holds a `urn:uuid` or seed reference, or references a resource that does not exist.
 * `dropMarkers` simulates a `$book` that keeps neither identifiers nor tags.
 */
function statefulMedplum(options?: { failVerificationFinds?: boolean; dropMarkers?: boolean }) {
  const server = new FakeMedplum();
  const store = new Map<string, Resource>(); // `Type/id` → current version
  const history = new Map<string, Resource[]>(); // `Type/id` → every version, oldest first
  let seq = 0;
  const all = (type: string) => [...store.values()].filter((r) => r.resourceType === type);
  const save = (ref: string, resource: Resource): Resource => {
    const versions = history.get(ref) ?? [];
    const saved = { ...resource, meta: { ...(resource['meta'] as object | undefined), versionId: `v${versions.length + 1}` } };
    history.set(ref, [...versions, saved]);
    store.set(ref, saved);
    return saved;
  };
  const create = (type: string, body: Resource): Resource => {
    const id = `${type.toLowerCase()}-${(seq += 1)}`;
    return save(`${type}/${id}`, { ...body, id });
  };
  const brokenReference = (body: unknown): string | undefined => {
    const text = JSON.stringify(body);
    if (/urn:uuid|\?identifier=/.test(text)) return 'unresolved reference';
    return [...text.matchAll(/"reference":"([^"]+)"/g)].map((m) => m[1] ?? '').find((ref) => !store.has(ref));
  };

  const conditionalCreate = (call: RecordedCall): Reply => {
    const broken = brokenReference(call.body);
    if (broken !== undefined) return { status: 400, body: outcome(`Invalid reference: ${broken}`) };
    const condition = decodeURIComponent(call.headers.get('if-none-exist') ?? '');
    const existing = all(call.path).find((r) => condition === `identifier=${SEED_KEY_SYSTEM}|${seedKeyOf(r)}`);
    if (existing) return { status: 200, body: existing };
    return { status: 201, body: create(call.path, call.body as Resource) };
  };
  const putSlot = (call: RecordedCall): Reply => {
    const current = store.get(call.path);
    if (!current) return { status: 404 };
    if (call.headers.get('if-match') !== `W/"${(current['meta'] as { versionId: string }).versionId}"`) {
      return { status: 412, body: outcome('Precondition failed: version mismatch', 'conflict') };
    }
    return { status: 200, body: save(call.path, call.body as Resource) };
  };
  const book = (call: RecordedCall): Reply => {
    const input = (call.body as { parameter: { resource: Resource }[] }).parameter[0]?.resource ?? { resourceType: 'Appointment' };
    const { meta: _meta, ...rest } = input;
    const booked = create('Appointment', options?.dropMarkers ? { ...rest, identifier: [], status: 'booked' } : { ...input, status: 'booked' });
    return { status: 201, body: { resourceType: 'Bundle', type: 'transaction-response', entry: [{ resource: booked }] } };
  };
  const cancel = (call: RecordedCall): Reply => {
    const ref = call.path.replace('/$cancel', '');
    const appointment = store.get(ref);
    if (!appointment) return { status: 404 };
    return { status: 200, body: save(ref, { ...appointment, status: 'cancelled' }) };
  };

  server.on('POST', /^(Organization|Location|HealthcareService|Practitioner|Schedule|Patient|Slot)$/, conditionalCreate);
  for (const type of ['Organization', 'Location', 'HealthcareService', 'Schedule', 'Practitioner', 'Patient', 'Slot']) {
    server.on('GET', new RegExp(`^${type}$`), (call) => {
      const identifier = call.query.get('identifier');
      const ids = call.query.get('_id')?.split(',');
      const found = all(type).filter((r) => (identifier ? identifier === `${SEED_KEY_SYSTEM}|${seedKeyOf(r)}` : true) && (ids ? ids.includes(r.id ?? '') : true));
      return { status: 200, body: bundle(found) };
    });
  }
  server.on('GET', /^(Patient|Appointment)\/[^/$]+$/, (call) => {
    const r = store.get(call.path);
    return r ? { status: 200, body: r } : { status: 404 };
  });
  server.on('GET', /^Appointment\/[^/]+\/_history$/, (call) => {
    const versions = history.get(call.path.replace('/_history', '')) ?? [];
    return { status: 200, body: { ...bundle([...versions].reverse()), type: 'history' } };
  });
  server.on('PUT', /^Slot\/[^/]+$/, putSlot);
  server.on('GET', /^Appointment$/, (call) => {
    const patient = call.query.get('patient');
    const from = Date.parse((call.query.get('date') ?? 'ge1970-01-01').slice(2));
    const found = all('Appointment').filter((a) => JSON.stringify(a['participant']).includes(`"${patient}"`) && Date.parse(String(a['start'])) >= from);
    return { status: 200, body: bundle(found) };
  });
  server.on('GET', /^Appointment\/\$find$/, (call: RecordedCall) => {
    // The final verification asks for one slot (`_count` = limit + 1 = 2); booking asks for more.
    if (options?.failVerificationFinds && call.query.get('_count') === '2') return { status: 503 };
    const scheduleRef = call.query.get('schedule') ?? '';
    const sched = store.get(scheduleRef);
    const practitionerRef = (sched?.['actor'] as { reference: string }[] | undefined)?.[0]?.reference ?? '';
    const serviceId = (call.query.get('service-type-reference') ?? '').split('/')[1] ?? '';
    const start = new Date(call.query.get('start') ?? '').toISOString();
    return { status: 200, body: findReply([proposed([scheduleRef.split('/')[1] ?? ''], practitionerRef.split('/')[1] ?? '', serviceId, start, 20)]) };
  });
  server.on('POST', /^Appointment\/\$book$/, book);
  server.on('POST', /^Appointment\/[^/]+\/\$cancel$/, cancel);
  return { server, store, all, save, create, conditionalCreate, putSlot, book, cancel };
}

type FakeState = ReturnType<typeof statefulMedplum>;

function connect(server: FakeMedplum) {
  const client = new MedplumClient({ baseUrl: 'https://medplum.test', clientId: 'id', clientSecret: 'secret', fetch: server.fetch, retryDelayMs: 1 });
  const scheduling = new MedplumSchedulingSystem({ tenantId: 'demo', client, nationalIdSystem: NATIONAL_ID_SYSTEM, directoryTtlMs: 0, now: () => NOW });
  const ctx = { tenant: { tenantId: 'demo', agentId: 'demo-clinic' }, signal: new AbortController().signal };
  return { client, scheduling, ctx };
}

function apply(server: FakeMedplum, plan: SeedPlan, resetAppointments = false) {
  const { client, scheduling, ctx } = connect(server);
  return applySeedPlan(plan, dataset(), { client, scheduling, ctx, log: silentLogger, now: () => NOW }, { resetAppointments });
}

const idOfKey = (state: FakeState, type: string, key: string): string => state.all(type).find((r) => seedKeyOf(r) === key)?.id ?? '';
const seedAppointment = (state: FakeState, key: string) => state.all('Appointment').find((a) => a['status'] === 'booked' && seedAppointmentKey(a) === `appointment:${key}`);
const keys = (issues: readonly { key: string }[] | undefined) => (issues ?? []).map((i) => i.key);

describe('Medplum seed --apply (against a local stand-in, never a real server)', () => {
  it('creates every resource with its own request and real IDs, books the planned appointments, and verifies free time', async () => {
    const state = statefulMedplum();
    const plan = planFor(ANCHOR);
    const report = await apply(state.server, plan);
    expect(report.complete).toBe(true);
    expect(report.resources).toEqual({ created: plan.resources.map((r) => r.key), existing: [], failed: [], uncertain: [] });
    expect(report.blocks).toEqual({ created: [BLOCK_KEY], moved: [], unchanged: [], failed: [], uncertain: [] });
    expect(report.reset).toBeUndefined();
    expect(report.appointments).toEqual({ booked: APPOINTMENT_KEYS, alreadyPresent: [], unmarked: [], failed: [], uncertain: [] });
    expect(report.verification).toHaveLength(4);
    expect(report.verification.every((v) => v.hasFreeTime)).toBe(true);

    // No transaction or batch: one conditional create per resource.
    expect(state.server.fhir('POST', /^$/)).toEqual([]);
    const creates = state.server.fhir('POST', /^[A-Z][A-Za-z]+$/);
    expect(creates).toHaveLength(19); // 18 resources + 1 leave block
    for (const c of creates) expect(decodeURIComponent(c.headers.get('if-none-exist') ?? '')).toBe(`identifier=${SEED_KEY_SYSTEM}|${seedKeyOf(c.body)}`);
    // References carry the real IDs returned by earlier creates.
    const schedule = state.all('Schedule').find((s) => seedKeyOf(s) === 'schedule:dr-sara:dermatology');
    expect(schedule?.['actor']).toEqual([{ reference: `Practitioner/${idOfKey(state, 'Practitioner', 'practitioner:dr-sara')}`, display: 'سارة الغامدي' }]);
    expect(state.all('Slot')[0]?.['schedule']).toEqual({ reference: `Schedule/${schedule?.id ?? ''}` });

    const booked = state.all('Appointment');
    expect(booked.map((a) => a['start']).sort()).toEqual(plan.appointments.map((a) => a.start).sort());
    expect(booked.map((a) => seedAppointmentKey(a)).sort()).toEqual(['appointment:appt-child', 'appointment:appt-one', 'appointment:appt-two-a', 'appointment:appt-two-b']);
    // Every $find asked about exactly one schedule.
    expect(state.server.fhir('GET', /^Appointment\/\$find$/).every((c) => c.query.getAll('schedule').length === 1)).toBe(true);
  });

  it('reports a failed availability check instead of failing after the data was written', async () => {
    const state = statefulMedplum({ failVerificationFinds: true });
    const report = await apply(state.server, planFor(ANCHOR));
    expect(report.appointments.booked).toHaveLength(4);
    expect(state.all('Appointment')).toHaveLength(4);
    expect(report.verification).toHaveLength(4);
    for (const v of report.verification) expect(v).toMatchObject({ hasFreeTime: false, error: expect.stringContaining('HTTP 503') as unknown });
  });

  it('is safe to re-run: it reuses what exists, overwrites nothing and touches no manual resource', async () => {
    const state = statefulMedplum();
    const plan = planFor(ANCHOR);
    await apply(state.server, plan);
    // Someone edits a seeded resource and adds their own.
    const saraRef = `Practitioner/${idOfKey(state, 'Practitioner', 'practitioner:dr-sara')}`;
    const sara = state.store.get(saraRef);
    if (!sara) throw new Error('seeded practitioner missing');
    state.save(saraRef, { ...sara, telecom: [{ system: 'email', value: 'edited@example.test' }] });
    const manual = state.create('Practitioner', { resourceType: 'Practitioner', name: [{ text: 'Manual Entry' }] });

    const again = await apply(state.server, plan);
    expect(again.complete).toBe(true);
    expect(again.resources).toEqual({ created: [], existing: plan.resources.map((r) => r.key), failed: [], uncertain: [] });
    expect(again.blocks.unchanged).toEqual([BLOCK_KEY]);
    expect(again.appointments.alreadyPresent).toEqual(APPOINTMENT_KEYS);
    expect(again.appointments.booked).toEqual([]);
    expect(state.all('Appointment')).toHaveLength(4);
    expect(state.all('Patient')).toHaveLength(5);
    expect(state.all('Slot')).toHaveLength(1);
    expect(state.server.fhir('PUT')).toEqual([]);
    expect(state.store.get(saraRef)?.['telecom']).toEqual([{ system: 'email', value: 'edited@example.test' }]);
    expect(state.store.get(`Practitioner/${manual.id ?? ''}`)).toEqual(manual);
  });

  it('does not add appointments when re-run on another day: one upcoming seed appointment per key', async () => {
    const state = statefulMedplum();
    await apply(state.server, planFor(ANCHOR));
    const report = await apply(state.server, planFor('2026-10-12'));
    expect(report.appointments.alreadyPresent).toEqual(APPOINTMENT_KEYS);
    expect(report.appointments.booked).toEqual([]);
    expect(state.all('Appointment')).toHaveLength(4);
  });

  describe('partial failures', () => {
    it('a refused create stops only what depends on it; a re-run completes it without duplicates', async () => {
      const state = statefulMedplum();
      let refuse = true;
      state.server.on('POST', /^Schedule$/, (call) =>
        refuse && seedKeyOf(call.body) === 'schedule:dr-sara:dermatology' ? { status: 403, body: outcome('Forbidden', 'forbidden') } : state.conditionalCreate(call),
      );
      const plan = planFor(ANCHOR);
      const first = await apply(state.server, plan);
      expect(first.complete).toBe(false);
      expect(first.resources.failed).toEqual([{ key: 'schedule:dr-sara:dermatology', reason: expect.stringContaining('HTTP 403') as unknown }]);
      expect(first.resources.created).toHaveLength(17);
      expect(first.blocks.failed).toEqual([{ key: BLOCK_KEY, reason: 'depends on unresolved schedule:dr-sara:dermatology' }]);
      expect(first.appointments.booked).toEqual(['appt-one', 'appt-two-b', 'appt-child']);
      expect(keys(first.appointments.failed)).toEqual(['appt-two-a']);

      refuse = false;
      const second = await apply(state.server, plan);
      expect(second.complete).toBe(true);
      expect(second.resources.created).toEqual(['schedule:dr-sara:dermatology']);
      expect(second.resources.existing).toHaveLength(17);
      expect(second.blocks.created).toEqual([BLOCK_KEY]);
      expect(second.appointments.booked).toEqual(['appt-two-a']);
      expect(second.appointments.alreadyPresent).toEqual(['appt-one', 'appt-two-b', 'appt-child']);
      expect(state.all('Schedule')).toHaveLength(4);
      expect(state.all('Appointment')).toHaveLength(4);
    });

    it('an unclear reply to a create is checked by reading: a lost reply is not duplicated, an unconfirmed create is reported', async () => {
      const state = statefulMedplum();
      let flaky = true;
      state.server.on('POST', /^Patient$/, (call) => {
        const key = seedKeyOf(call.body);
        if (flaky && key === 'patient:patient-child') {
          state.conditionalCreate(call); // applied, but the reply is lost
          return { status: 504 };
        }
        if (flaky && key === 'patient:patient-mother') return { status: 503 }; // not applied
        return state.conditionalCreate(call);
      });
      const plan = planFor(ANCHOR);
      const first = await apply(state.server, plan);
      expect(first.complete).toBe(false);
      expect(first.resources.created).toContain('patient:patient-child');
      expect(first.resources.uncertain).toEqual([{ key: 'patient:patient-mother', reason: expect.stringContaining('not found afterwards') as unknown }]);
      expect(state.all('Patient')).toHaveLength(4);
      expect(first.appointments.booked).toContain('appt-child'); // the reconciled ID is used

      flaky = false;
      const second = await apply(state.server, plan);
      expect(second.complete).toBe(true);
      expect(second.resources.created).toEqual(['patient:patient-mother']);
      expect(state.all('Patient')).toHaveLength(5);
      expect(state.all('Patient').filter((p) => seedKeyOf(p) === 'patient:patient-child')).toHaveLength(1);
    });

    it('an unclear reply to $book is checked: a booking that went through is not repeated, one that did not is reported', async () => {
      const state = statefulMedplum();
      let calls = 0;
      state.server.on('POST', /^Appointment\/\$book$/, (call) => {
        calls += 1;
        if (calls === 1) {
          state.book(call); // appt-one: applied, reply lost
          return { status: 504 };
        }
        if (calls === 2) return { status: 504 }; // appt-two-a: not applied
        return state.book(call);
      });
      const plan = planFor(ANCHOR);
      const first = await apply(state.server, plan);
      expect(first.complete).toBe(false);
      expect(first.appointments.booked).toEqual(['appt-one', 'appt-two-b', 'appt-child']);
      expect(first.appointments.failed).toEqual([{ key: 'appt-two-a', reason: expect.stringContaining('checked: not booked') as unknown }]);
      expect(state.all('Appointment')).toHaveLength(3);

      const second = await apply(state.server, plan);
      expect(second.complete).toBe(true);
      expect(second.appointments.booked).toEqual(['appt-two-a']);
      expect(state.all('Appointment')).toHaveLength(4);
    });
  });

  describe('--reset-appointments', () => {
    it('cancels the seed’s own unchanged appointments and books them again', async () => {
      const state = statefulMedplum();
      const plan = planFor(ANCHOR);
      await apply(state.server, plan);
      const report = await apply(state.server, plan, true);
      expect(report.complete).toBe(true);
      expect(report.reset).toEqual({ cancelled: APPOINTMENT_KEYS.map((k) => `appointment:${k}`), kept: [], notSeeded: 0, failed: [], uncertain: [] });
      expect(report.appointments.booked).toEqual(APPOINTMENT_KEYS);
      expect(state.all('Appointment').filter((a) => a['status'] === 'booked')).toHaveLength(4);
      expect(state.all('Appointment').filter((a) => a['status'] === 'cancelled')).toHaveLength(4);
    });

    it('never cancels appointments the seed did not make, even for seeded patients', async () => {
      const state = statefulMedplum();
      const plan = planFor(ANCHOR);
      await apply(state.server, plan);

      // Mujeeb books for a seeded patient during testing, through the normal port path.
      const { scheduling, ctx } = connect(state.server);
      const from = new Date('2026-10-20T13:00:00Z'); // Tuesday 16:00 in Riyadh
      const { slots } = await scheduling.findAvailability(ctx, {
        serviceId: idOfKey(state, 'HealthcareService', 'service:family-medicine'),
        practitionerIds: [idOfKey(state, 'Practitioner', 'practitioner:dr-fahad')],
        from,
        to: new Date(from.getTime() + 3_600_000),
        limit: 1,
      });
      const slot = slots[0];
      if (!slot) throw new Error('fake $find offered no slot');
      const mujeeb = await scheduling.book(ctx, { patientId: idOfKey(state, 'Patient', 'patient:patient-no-appointments'), slot, idempotencyKey: 'session-1:C1:0123456789abcdef' });

      const report = await apply(state.server, plan, true);
      expect(report.reset?.cancelled).toHaveLength(4);
      expect(report.reset?.notSeeded).toBe(1);
      expect(state.store.get(`Appointment/${mujeeb.id}`)?.['status']).toBe('booked');
      const cancelled = state.all('Appointment').filter((a) => a['status'] === 'cancelled');
      expect(cancelled).toHaveLength(4);
      for (const a of cancelled) expect(seedAppointmentKey(a)).toBeDefined();
    });

    it('keeps a seed appointment changed after seeding (e.g. rescheduled through Mujeeb) and does not book it twice', async () => {
      const state = statefulMedplum();
      const plan = planFor(ANCHOR);
      await apply(state.server, plan);
      const one = seedAppointment(state, 'appt-one');
      if (!one?.id) throw new Error('seed appointment missing');
      // A reschedule keeps the same Appointment (and its markers) with a new time and a new version.
      state.save(`Appointment/${one.id}`, { ...one, start: '2026-10-21T14:00:00.000Z', end: '2026-10-21T14:20:00.000Z' });

      const report = await apply(state.server, plan, true);
      expect(report.complete).toBe(true);
      expect(report.reset?.kept).toEqual([{ key: 'appointment:appt-one', reason: 'changed since the seed booked it' }]);
      expect([...(report.reset?.cancelled ?? [])].sort()).toEqual(['appointment:appt-child', 'appointment:appt-two-a', 'appointment:appt-two-b']);
      expect(state.store.get(`Appointment/${one.id}`)).toMatchObject({ status: 'booked', start: '2026-10-21T14:00:00.000Z' });
      expect(report.appointments.alreadyPresent).toEqual(['appt-one']);
      expect(report.appointments.booked).toEqual(['appt-two-a', 'appt-two-b', 'appt-child']);
      expect(state.all('Appointment').filter((a) => a['status'] === 'booked' && seedAppointmentKey(a) === 'appointment:appt-one')).toHaveLength(1);
    });

    it('cancels nothing when an appointment’s history cannot be read (state unclear)', async () => {
      const state = statefulMedplum();
      const plan = planFor(ANCHOR);
      await apply(state.server, plan);
      state.server.on('GET', /^Appointment\/[^/]+\/_history$/, () => ({ status: 403, body: outcome('Forbidden', 'forbidden') }));

      const report = await apply(state.server, plan, true);
      expect(report.reset?.cancelled).toEqual([]);
      expect(report.reset?.kept).toHaveLength(4);
      for (const k of report.reset?.kept ?? []) expect(k.reason).toMatch(/history unavailable .*state unclear/);
      expect(state.server.fhir('POST', /\/\$cancel$/)).toEqual([]);
      expect(report.appointments.alreadyPresent).toEqual(APPOINTMENT_KEYS);
      expect(state.all('Appointment')).toHaveLength(4);
    });

    it('checks unclear cancellations: confirmed ones are re-booked, refused ones stay, unconfirmed ones are never booked twice', async () => {
      const state = statefulMedplum();
      const plan = planFor(ANCHOR);
      await apply(state.server, plan);
      const [one, twoA, twoB] = ['appt-one', 'appt-two-a', 'appt-two-b'].map((k) => seedAppointment(state, k));
      state.server.on('POST', /^Appointment\/[^/]+\/\$cancel$/, (call) => {
        const id = call.path.split('/')[1];
        if (id === one?.id) {
          state.cancel(call); // cancelled, reply lost
          return { status: 504 };
        }
        if (id === twoA?.id || id === twoB?.id) return { status: 504 }; // not cancelled
        return state.cancel(call);
      });
      state.server.on('GET', new RegExp(`^Appointment/${twoB?.id ?? '-'}$`), () => ({ status: 503 })); // appt-two-b: state cannot be read

      const report = await apply(state.server, plan, true);
      expect(report.complete).toBe(false);
      expect([...(report.reset?.cancelled ?? [])].sort()).toEqual(['appointment:appt-child', 'appointment:appt-one']);
      expect(keys(report.reset?.failed)).toEqual(['appointment:appt-two-a']);
      expect(keys(report.reset?.uncertain)).toEqual(['appointment:appt-two-b']);
      expect(report.appointments.booked).toEqual(['appt-one', 'appt-child']);
      expect(report.appointments.alreadyPresent).toEqual(['appt-two-a']);
      expect(keys(report.appointments.uncertain)).toEqual(['appt-two-b']);
      expect(state.all('Appointment').filter((a) => a['status'] === 'booked')).toHaveLength(4);
    });

    it('cancels nothing when Medplum does not keep the seed markers, reports it, and still never double-books', async () => {
      const state = statefulMedplum({ dropMarkers: true });
      const plan = planFor(ANCHOR);
      const first = await apply(state.server, plan);
      expect(first.appointments.booked).toHaveLength(4);
      expect(first.appointments.unmarked).toEqual(APPOINTMENT_KEYS);

      const reset = await apply(state.server, plan, true);
      expect(reset.reset).toEqual({ cancelled: [], kept: [], notSeeded: 4, failed: [], uncertain: [] });
      expect(state.server.fhir('POST', /\/\$cancel$/)).toEqual([]);
      expect(reset.appointments.alreadyPresent).toHaveLength(4); // found by time instead
      expect(state.all('Appointment').filter((a) => a['status'] === 'booked')).toHaveLength(4);
    });

    it('recognises only appointments carrying both the seed key and the synthetic tag', () => {
      const key = { system: SEED_KEY_SYSTEM, value: 'appointment:appt-one' };
      const base = { resourceType: 'Appointment', status: 'booked' };
      expect(seedAppointmentKey({ ...base, identifier: [key], meta: { tag: [SYNTHETIC_TAG] } })).toBe('appointment:appt-one');
      expect(seedAppointmentKey({ ...base, identifier: [key] })).toBeUndefined();
      expect(seedAppointmentKey({ ...base, meta: { tag: [SYNTHETIC_TAG] } })).toBeUndefined();
      expect(seedAppointmentKey({ ...base, identifier: [{ system: SEED_KEY_SYSTEM, value: 'patient:patient-one-upcoming' }], meta: { tag: [SYNTHETIC_TAG] } })).toBeUndefined();
      expect(seedAppointmentKey({ ...base, identifier: [{ system: 'urn:mujeeb:idempotency-key', value: 'seed:appt-one:2026-10-13' }], meta: { tag: [SYNTHETIC_TAG] } })).toBeUndefined();
    });
  });

  describe('leave blocks', () => {
    it('keeps exactly one block when re-run on another day: moved with a version check, other fields kept', async () => {
      const state = statefulMedplum();
      await apply(state.server, planFor(ANCHOR));
      const [created] = state.all('Slot');
      if (!created?.id) throw new Error('block missing');
      const ref = `Slot/${created.id}`;
      state.save(ref, { ...created, specialty: [{ text: 'added by hand' }] }); // now version v2

      const moved = await apply(state.server, planFor('2026-10-12'));
      expect(moved.blocks).toEqual({ created: [], moved: [BLOCK_KEY], unchanged: [], failed: [], uncertain: [] });
      expect(state.server.fhir('PUT', /^Slot\//).map((c) => c.headers.get('if-match'))).toEqual(['W/"v2"']);
      expect(state.all('Slot')).toHaveLength(1);
      expect(state.store.get(ref)).toMatchObject({
        status: 'busy-unavailable',
        start: '2026-10-12T21:00:00.000Z',
        end: '2026-10-15T21:00:00.000Z',
        specialty: [{ text: 'added by hand' }],
        meta: { tag: [SYNTHETIC_TAG] },
      });

      const sameDay = await apply(state.server, planFor('2026-10-12'));
      expect(sameDay.blocks.unchanged).toEqual([BLOCK_KEY]);
      expect(state.server.fhir('POST', /^Slot$/)).toHaveLength(1);
      expect(state.server.fhir('PUT', /^Slot\//)).toHaveLength(1);
    });

    it('does not move a block changed concurrently (version conflict) and reports it', async () => {
      const state = statefulMedplum();
      await apply(state.server, planFor(ANCHOR));
      const [block] = state.all('Slot');
      state.server.on('PUT', /^Slot\/[^/]+$/, (call) => {
        if (block?.id) state.save(`Slot/${block.id}`, { ...(state.store.get(`Slot/${block.id}`) as Resource), comment: 'edited meanwhile' });
        return state.putSlot(call);
      });

      const report = await apply(state.server, planFor('2026-10-12'));
      expect(report.complete).toBe(false);
      expect(report.blocks.failed).toEqual([{ key: BLOCK_KEY, reason: 'changed since it was read (version conflict); not moved' }]);
      expect(state.all('Slot')[0]).toMatchObject({ start: '2026-10-11T21:00:00.000Z', comment: 'edited meanwhile' });
    });

    it('leaves alone a Slot that carries the seed key without the synthetic tag (ownership unclear)', async () => {
      const state = statefulMedplum();
      const plan = planFor(ANCHOR);
      await apply(state.server, plan);
      const [block] = state.all('Slot');
      if (!block?.id) throw new Error('block missing');
      const { meta: _meta, ...untagged } = block;
      state.save(`Slot/${block.id}`, untagged);

      const report = await apply(state.server, planFor('2026-10-12'));
      expect(report.blocks.failed).toEqual([{ key: BLOCK_KEY, reason: 'carries the seed key but not the synthetic tag: ownership unclear, left unchanged' }]);
      expect(state.server.fhir('PUT')).toEqual([]);
    });
  });

  it('stamps markers only when asked: a normal booking carries just the idempotency identifier', async () => {
    const server = withDirectory(new FakeMedplum())
      .on('GET', /^Patient\/p-1$/, () => ({ status: 200, body: { resourceType: 'Patient', id: 'p-1' } }))
      .on('POST', /^Appointment\/\$book$/, (call) => {
        const input = (call.body as { parameter: { resource: Resource }[] }).parameter[0]?.resource ?? { resourceType: 'Appointment' };
        return { status: 201, body: bundle([{ ...input, id: 'a-1', status: 'booked' }]) };
      });
    const { scheduling, ctx } = connect(server);
    const start = '2026-10-12T13:00:00.000Z';
    const appointment = proposed(['sch-fahad'], 'pr-fahad', 'hs-family', start, 20);
    const slot = {
      start: new Date(start),
      end: new Date(Date.parse(start) + 1_200_000),
      serviceId: 'hs-family',
      serviceName: 'طب الأسرة',
      practitionerId: 'pr-fahad',
      practitionerName: 'فهد العتيبي',
      token: Buffer.from(JSON.stringify({ v: 1, schedule: 'sch-fahad', practitioner: 'pr-fahad', service: 'hs-family', start, appointment })).toString('base64url'),
    };
    await scheduling.book(ctx, { patientId: 'p-1', slot, idempotencyKey: 'k-1' });
    await scheduling.bookMarked(ctx, { patientId: 'p-1', slot, idempotencyKey: 'k-2' }, { identifiers: [{ system: SEED_KEY_SYSTEM, value: 'appointment:x' }], tags: [SYNTHETIC_TAG] });
    const [plain, marked] = server.fhir('POST', /^Appointment\/\$book$/).map((c) => (c.body as { parameter: { resource: Resource }[] }).parameter[0]?.resource);
    expect(plain?.['identifier']).toEqual([{ system: 'urn:mujeeb:idempotency-key', value: 'k-1' }]);
    expect(plain?.['meta']).toBeUndefined();
    expect(marked?.['identifier']).toEqual([
      { system: 'urn:mujeeb:idempotency-key', value: 'k-2' },
      { system: SEED_KEY_SYSTEM, value: 'appointment:x' },
    ]);
    expect(marked?.['meta']).toEqual({ tag: [SYNTHETIC_TAG] });
  });
});
