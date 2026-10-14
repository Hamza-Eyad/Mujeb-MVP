import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MemorySchedulingSystem } from '../../src/adapters/fakes/memory-scheduling.js';
import { type SchedulingDataset, parseSchedulingDataset } from '../../src/contracts/scheduling-dataset.js';
import { CancelledError, ConfigError, ProviderError } from '../../src/core/errors.js';
import type { SchedulingContext } from '../../src/ports/scheduling.js';
import { type SchedulingContractFixture, describeSchedulingContract } from './scheduling-system.contract.js';

const DATASET_FILE = 'config/test-data/demo-clinic.dataset.json';
const TENANT = { tenantId: 'demo', agentId: 'demo-clinic' };

function dataset(): SchedulingDataset {
  return parseSchedulingDataset(JSON.parse(readFileSync(DATASET_FILE, 'utf8')));
}

function ctx(signal: AbortSignal = new AbortController().signal): SchedulingContext {
  return { tenant: TENANT, signal };
}

function memory(nowIso: string): MemorySchedulingSystem {
  return new MemorySchedulingSystem({ tenantId: TENANT.tenantId, dataset: dataset(), now: () => new Date(nowIso) });
}

function fixture(nowIso: string): SchedulingContractFixture {
  const now = (): Date => new Date(nowIso);
  const system = memory(nowIso);
  return {
    system,
    dataset: dataset(),
    anchorDate: system.anchorDate,
    now,
    ctx,
    foreignCtx: () => ({ tenant: { tenantId: 'other-clinic', agentId: 'x' }, signal: new AbortController().signal }),
  };
}

// Sunday 08:00 in Riyadh — a full working week ahead.
describeSchedulingContract('memory (Sunday morning)', () => fixture('2026-10-11T05:00:00Z'));
// Thursday 22:30 in Riyadh — the weekend comes first; relative dataset dates must still land on working days.
describeSchedulingContract('memory (Thursday night)', () => fixture('2026-10-15T19:30:00Z'));

describe('MemorySchedulingSystem specifics', () => {
  const nowIso = '2026-10-11T05:00:00Z';

  it('uses opaque IDs that are not the dataset keys', async () => {
    const system = memory(nowIso);
    const ds = dataset();
    const { entries } = await system.searchDirectory(ctx(), { kind: 'any', limit: 50 });
    const ids = entries.map((e) => (e.kind === 'service' ? e.service.id : e.practitioner.id));
    const keys = new Set([...ds.services.map((s) => s.key), ...ds.practitioners.map((p) => p.key)]);
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) expect(keys.has(id)).toBe(false);
  });

  it('returns copies, never its internal state', async () => {
    const system = memory(nowIso);
    const [patient] = await system.findPatients(ctx(), { phone: '+966500000101' });
    if (!patient) throw new Error('patient missing');
    const [appointment] = await system.listAppointments(ctx(), { patientId: patient.id });
    if (!appointment) throw new Error('appointment missing');
    const originalStart = appointment.start.getTime();
    appointment.start.setTime(0);
    expect((await system.getAppointment(ctx(), appointment.id)).start.getTime()).toBe(originalStart);
  });

  it('aborts simulated latency promptly', async () => {
    const system = new MemorySchedulingSystem({ tenantId: TENANT.tenantId, dataset: dataset(), now: () => new Date(nowIso), latencyMs: 5_000 });
    const controller = new AbortController();
    const started = Date.now();
    const pending = system.searchDirectory(ctx(controller.signal), { kind: 'any', limit: 5 });
    setTimeout(() => controller.abort(new CancelledError('barge_in')), 10);
    await expect(pending).rejects.toBeInstanceOf(CancelledError);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('injects failures before a write (nothing changes) or after it (applied, outcome reported as failed)', async () => {
    const system = memory(nowIso);
    const [patient] = await system.findPatients(ctx(), { phone: '+966500000105' });
    if (!patient) throw new Error('patient missing');
    const { entries } = await system.searchDirectory(ctx(), { text: 'طب الأسرة', kind: 'service', limit: 1 });
    const service = entries[0]?.kind === 'service' ? entries[0].service : undefined;
    if (!service) throw new Error('service missing');
    const from = new Date('2026-10-12T00:00:00Z');
    const { slots } = await system.findAvailability(ctx(), { serviceId: service.id, from, to: new Date(from.getTime() + 3 * 86_400_000), limit: 2 });
    const [first, second] = slots;
    if (!first || !second) throw new Error('slots missing');

    system.failNext('book', new ProviderError('memory', 'unavailable', 'injected before commit'));
    await expect(system.book(ctx(), { patientId: patient.id, slot: first, idempotencyKey: 'k1' })).rejects.toMatchObject({ kind: 'unavailable' });
    expect(await system.listAppointments(ctx(), { patientId: patient.id })).toEqual([]);

    system.failNext('book', new ProviderError('memory', 'timeout', 'injected after commit'), { afterCommit: true });
    await expect(system.book(ctx(), { patientId: patient.id, slot: second, idempotencyKey: 'k2' })).rejects.toMatchObject({ kind: 'timeout' });
    const after = await system.listAppointments(ctx(), { patientId: patient.id });
    expect(after.map((a) => a.start.getTime())).toEqual([second.start.getTime()]); // applied despite the error: an unknown outcome to reconcile
  });

  it('rejects a slot whose token does not match it', async () => {
    const system = memory(nowIso);
    const [patient] = await system.findPatients(ctx(), { phone: '+966500000105' });
    const { entries } = await system.searchDirectory(ctx(), { text: 'جلدية', kind: 'service', limit: 1 });
    const service = entries[0]?.kind === 'service' ? entries[0].service : undefined;
    if (!patient || !service) throw new Error('fixture data missing');
    const from = new Date('2026-10-11T06:00:00Z');
    const { slots } = await system.findAvailability(ctx(), { serviceId: service.id, from, to: new Date(from.getTime() + 7 * 86_400_000), limit: 1 });
    const [slot] = slots;
    if (!slot) throw new Error('slot missing');
    const forged = { ...slot, start: new Date(slot.start.getTime() + 30 * 60_000) };
    await expect(system.book(ctx(), { patientId: patient.id, slot: forged, idempotencyKey: 'forged' })).rejects.toMatchObject({ name: 'SchedulingError', kind: 'invalid_request' });
  });

  it('refuses a dataset appointment that does not fit working hours', () => {
    const broken = dataset();
    const first = broken.appointments[0];
    if (!first) throw new Error('dataset has no appointments');
    broken.appointments[0] = { ...first, time: '23:40' };
    expect(() => new MemorySchedulingSystem({ tenantId: TENANT.tenantId, dataset: broken, now: () => new Date(nowIso) })).toThrow(ConfigError);
  });
});
