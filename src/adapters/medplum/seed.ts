import { ProviderError, SchedulingError } from '../../core/errors.js';
import type { Logger } from '../../core/logger.js';
import { type LocalDate, addDays, zonedToInstant } from '../../core/zoned-time.js';
import { type SchedulingDataset, resolveDatasetDates } from '../../contracts/scheduling-dataset.js';
import type { AvailableSlot, SchedulingContext } from '../../ports/scheduling.js';
import { MEDPLUM, type MedplumClient } from './client.js';
import { FHIR_TIMEZONE_EXTENSION, SCHEDULING_PARAMETERS_EXTENSION, SERVICE_TYPE_REFERENCE_EXTENSION, asRecord, bundleSchema } from './fhir-schemas.js';
import type { MedplumSchedulingSystem } from './medplum-scheduling.js';

/**
 * Seeds a Medplum sandbox project from the provider-neutral synthetic dataset (DECISIONS A17).
 *
 * - `buildSeedPlan` is pure: the resources to create, in dependency order and each with a stable seed key,
 *   the leave blocks, and the appointments to book. Dry runs stop here.
 * - `applySeedPlan` works one request at a time. It uses no FHIR transaction (so no `transaction-bundles`
 *   feature flag and no limit on conditional entries) and no `urn:uuid` references:
 *   1. each resource is looked up by its seed key and created only when missing (conditional create,
 *      `If-None-Exist`); references carry the real IDs of the resources found or created before it;
 *   2. each leave block is one Slot per stable seed key, moved in place (version-checked, other fields
 *      kept) when the anchor day changes, so blocks never pile up;
 *   3. appointments are booked through the scheduling adapter (`$find` + `$book`, the agent's path),
 *      marked with a seed key and the synthetic tag; finally, free time is checked.
 * - Every operation is reported. `failed`: definitely not applied. `uncertain`: a write may have been
 *   applied (it is checked once by reading). Work that depends on an unresolved resource is skipped.
 *   A re-run finds what exists and continues where the last run stopped, without duplicates.
 * - Only resources carrying a seed key are touched. Existing resources are reused, never overwritten.
 *   `--reset-appointments` cancels a seed appointment only when it is provably unchanged since the seed
 *   booked it (one version in its history); anything changed or unclear is kept.
 */

export const SEED_KEY_SYSTEM = 'urn:mujeeb:seed-key';
export const SYNTHETIC_TAG = { system: 'urn:mujeeb:tag', code: 'synthetic-seed', display: 'Synthetic test data (Mujeeb)' } as const;
/** Seed keys of appointments booked by the seed start with this prefix. */
export const SEED_APPOINTMENT_PREFIX = 'appointment:';
const SERVICE_CODE_SYSTEM = 'urn:mujeeb:service';
const UCUM = 'http://unitsofmeasure.org';
const SEARCH_PAGE_SIZE = 100;
const MAX_SEARCH_PAGES = 5;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
/** Transport failures that prove a write was refused before anything was applied. */
const DEFINITIVE_PROVIDER_FAILURES: ReadonlySet<string> = new Set(['auth', 'bad_request', 'quota', 'rate_limit']);

/** One resource of the plan. */
export interface PlannedResource {
  /** Stable seed key: how the resource is found again on every run. */
  key: string;
  resourceType: string;
  /** Seed keys of the resources this one references. They come earlier in the plan. */
  dependsOn: string[];
  /**
   * Body of the conditional create. References to other seeded resources are written as conditional
   * references (`Type?identifier=urn:mujeeb:seed-key|<key>`) and replaced by the real `Type/<id>` before sending.
   */
  resource: Record<string, unknown>;
}

export interface PlannedAppointment {
  key: string;
  patientKey: string;
  practitionerKey: string;
  serviceKey: string;
  date: LocalDate;
  time: string;
  /** Instant (ISO) of the clinic-local date/time. */
  start: string;
  durationMinutes: number;
}

/** A leave block on one schedule: a `busy-unavailable` Slot. */
export interface PlannedBlock {
  /** Stable seed key (no dates): there is one Slot per block and schedule, moved in place when the dates change. */
  key: string;
  scheduleKey: string;
  /** Inclusive clinic-local dates. */
  startDate: LocalDate;
  endDate: LocalDate;
  /** Instants (ISO): start of `startDate`, start of the day after `endDate`. */
  start: string;
  end: string;
  reason: string;
}

export interface SeedPlan {
  anchorDate: LocalDate;
  timezone: string;
  /** Looked up or created one at a time, in this order. */
  resources: PlannedResource[];
  blocks: PlannedBlock[];
  appointments: PlannedAppointment[];
  counts: Record<string, number>;
}

export function buildSeedPlan(dataset: SchedulingDataset, anchorDate: LocalDate, options: { nationalIdSystem: string }): SeedPlan {
  const tz = dataset.clinic.timezone;
  const resources: PlannedResource[] = [];
  const add = (type: string, key: string, body: Record<string, unknown>): string => {
    const resource = { resourceType: type, meta: { tag: [SYNTHETIC_TAG] }, ...body, identifier: [...asIdentifiers(body['identifier']), { system: SEED_KEY_SYSTEM, value: key }] };
    const dependsOn = [...new Set(seedReferencesIn(resource).map((r) => r.key))];
    const unknown = dependsOn.filter((k) => !resources.some((r) => r.key === k));
    if (unknown.length > 0) throw new Error(`Seed plan: '${key}' references ${unknown.join(', ')} before it is planned`);
    resources.push({ key, resourceType: type, dependsOn, resource });
    return seedReference(type, key);
  };

  const organization = add('Organization', `organization:${dataset.clinic.key}`, { active: true, name: dataset.clinic.name });
  const location = add('Location', `location:${dataset.clinic.key}`, { status: 'active', name: dataset.clinic.locationName, managingOrganization: { reference: organization } });

  const services = new Map<string, { ref: string; name: string; duration: number }>();
  for (const s of dataset.services) {
    const duration = { value: s.durationMinutes, unit: 'min', system: UCUM, code: 'min' };
    const ref = add('HealthcareService', `service:${s.key}`, {
      active: true,
      name: s.name,
      type: [{ text: s.name, coding: [{ system: SERVICE_CODE_SYSTEM, code: s.key, display: s.name }] }],
      // Aliases (other spellings, English names) so directory search finds the service.
      specialty: s.aliases.map((text) => ({ text })),
      providedBy: { reference: organization },
      location: [{ reference: location }],
      extension: [
        {
          url: SCHEDULING_PARAMETERS_EXTENSION,
          extension: [
            { url: 'duration', valueDuration: duration },
            { url: 'alignmentInterval', valueDuration: duration },
            { url: 'alignmentTimezone', valueCode: tz },
          ],
        },
      ],
    });
    services.set(s.key, { ref, name: s.name, duration: s.durationMinutes });
  }

  const practitioners = new Map<string, string>();
  for (const p of dataset.practitioners) {
    const [given, ...family] = p.name.split(/\s+/);
    const ref = add('Practitioner', `practitioner:${p.key}`, {
      active: true,
      name: [{ text: p.name, given: [given ?? p.name], ...(family.length > 0 ? { family: family.join(' ') } : {}) }, ...p.aliases.map((text) => ({ text, use: 'nickname' }))],
      gender: p.gender,
      // Medplum resolves availability in the schedule actor's time zone.
      extension: [{ url: FHIR_TIMEZONE_EXTENSION, valueCode: tz }],
    });
    practitioners.set(p.key, ref);
  }

  const schedulesByPractitioner = new Map<string, string[]>();
  for (const p of dataset.practitioners) {
    for (const serviceKey of p.serviceKeys) {
      const service = services.get(serviceKey);
      const practitioner = practitioners.get(p.key);
      if (!service || !practitioner) continue;
      const scheduleKey = `schedule:${p.key}:${serviceKey}`;
      add('Schedule', scheduleKey, {
        active: true,
        actor: [{ reference: practitioner, display: p.name }],
        serviceType: [
          {
            text: service.name,
            coding: [{ system: SERVICE_CODE_SYSTEM, code: serviceKey, display: service.name }],
            extension: [{ url: SERVICE_TYPE_REFERENCE_EXTENSION, valueReference: { reference: service.ref, display: service.name } }],
          },
        ],
        extension: [
          {
            url: SCHEDULING_PARAMETERS_EXTENSION,
            extension: [
              { url: 'service', valueReference: { reference: service.ref, display: service.name } },
              {
                url: 'availability',
                extension: p.availability.map((a) => ({
                  url: 'availableTime',
                  extension: [
                    ...a.days.map((day) => ({ url: 'daysOfWeek', valueCode: day })),
                    { url: 'availableStartTime', valueTime: `${a.start}:00` },
                    { url: 'availableEndTime', valueTime: `${a.end}:00` },
                  ],
                })),
              },
            ],
          },
        ],
      });
      schedulesByPractitioner.set(p.key, [...(schedulesByPractitioner.get(p.key) ?? []), scheduleKey]);
    }
  }

  // Leave blocks are not created like the resources above: their dates follow the anchor day, so
  // `applySeedPlan` creates each one once and moves it in place afterwards.
  const resolved = resolveDatasetDates(dataset, anchorDate);
  const blocks: PlannedBlock[] = [];
  for (const block of resolved.blocks) {
    for (const scheduleKey of schedulesByPractitioner.get(block.practitionerKey) ?? []) {
      blocks.push({
        key: `block:${block.key}:${scheduleKey}`,
        scheduleKey,
        startDate: block.startDate,
        endDate: block.endDate,
        start: zonedToInstant(block.startDate, '00:00', tz).toISOString(),
        end: zonedToInstant(addDays(block.endDate, 1), '00:00', tz).toISOString(),
        reason: block.reason,
      });
    }
  }

  for (const p of dataset.patients) {
    const [given, ...family] = p.fullName.split(/\s+/);
    add('Patient', `patient:${p.key}`, {
      active: true,
      name: [{ text: p.fullName, given: [p.firstName ?? given ?? p.fullName], ...(family.length > 0 ? { family: family.join(' ') } : {}) }],
      birthDate: p.birthDate,
      gender: p.gender,
      telecom: [{ system: 'phone', value: p.phone, use: 'mobile' }],
      identifier: [{ system: options.nationalIdSystem, value: p.nationalId }],
    });
  }

  const appointments = resolved.appointments.map((a): PlannedAppointment => ({
    key: a.key,
    patientKey: a.patientKey,
    practitionerKey: a.practitionerKey,
    serviceKey: a.serviceKey,
    date: a.date,
    time: a.time,
    start: zonedToInstant(a.date, a.time, tz).toISOString(),
    durationMinutes: services.get(a.serviceKey)?.duration ?? 0,
  }));

  const counts: Record<string, number> = {};
  for (const r of resources) counts[r.resourceType] = (counts[r.resourceType] ?? 0) + 1;
  counts['Slot (leave block)'] = blocks.length;
  counts['Appointment (to book)'] = appointments.length;
  return { anchorDate, timezone: tz, resources, blocks, appointments, counts };
}

// ─────────────────────────────── apply ───────────────────────────────

export interface SeedDependencies {
  client: MedplumClient;
  /** The Medplum scheduling adapter: appointments are booked through the same `$find` + `$book` path the agent uses. */
  scheduling: MedplumSchedulingSystem;
  /** `signal` bounds the whole run. */
  ctx: SchedulingContext;
  log: Logger;
  now?: () => Date;
  /** Upper bound for each single operation. */
  requestTimeoutMs?: number;
}

/** An operation that did not complete: `failed` = definitely not applied; `uncertain` = may have been applied. */
export interface SeedIssue {
  key: string;
  reason: string;
}

export interface SeedReport {
  /** True when every operation completed. Otherwise re-run: it continues where this run stopped. */
  complete: boolean;
  resources: { created: string[]; existing: string[]; failed: SeedIssue[]; uncertain: SeedIssue[] };
  /** Leave-block Slots by seed key: created now, moved to the plan's dates, or already in place. */
  blocks: { created: string[]; moved: string[]; unchanged: string[]; failed: SeedIssue[]; uncertain: SeedIssue[] };
  /** `--reset-appointments` only. */
  reset?: {
    /** Seed keys of the seed's own unchanged future appointments that were cancelled. */
    cancelled: string[];
    /** Seed appointments left alone: changed since the seed booked them (e.g. rescheduled through Mujeeb), or state unclear. */
    kept: SeedIssue[];
    /** Future appointments of the seeded patients that the seed did not make (e.g. booked through Mujeeb): never touched. */
    notSeeded: number;
    failed: SeedIssue[];
    uncertain: SeedIssue[];
  };
  appointments: {
    booked: string[];
    /** The seed's appointment for this key is already upcoming (possibly on a date from an earlier run). */
    alreadyPresent: string[];
    /** Booked, but the stored Appointment does not carry the seed markers: a later reset cannot find it. */
    unmarked: string[];
    failed: SeedIssue[];
    uncertain: SeedIssue[];
  };
  verification: { practitionerKey: string; serviceKey: string; hasFreeTime: boolean; error?: string }[];
}

interface SeedRun {
  client: MedplumClient;
  scheduling: MedplumSchedulingSystem;
  /** Context for one operation: the run's signal plus the per-operation timeout. */
  op: () => SchedulingContext;
}

interface SeedAppointment {
  key: string;
  id: string;
}

/** Writes the plan to Medplum, one request at a time. Never called by a dry run. */
export async function applySeedPlan(plan: SeedPlan, dataset: SchedulingDataset, deps: SeedDependencies, options: { resetAppointments: boolean }): Promise<SeedReport> {
  const { client, scheduling, ctx } = deps;
  const now = deps.now ?? (() => new Date());
  const timeoutMs = deps.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const run: SeedRun = { client, scheduling, op: () => ({ ...ctx, signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(timeoutMs)]) }) };
  const report: SeedReport = {
    complete: false,
    resources: { created: [], existing: [], failed: [], uncertain: [] },
    blocks: { created: [], moved: [], unchanged: [], failed: [], uncertain: [] },
    appointments: { booked: [], alreadyPresent: [], unmarked: [], failed: [], uncertain: [] },
    verification: [],
  };

  // 1. Resources, in dependency order. `ids` maps seed keys to the real IDs found or created.
  const ids = new Map<string, string>();
  for (const planned of plan.resources) {
    const missing = planned.dependsOn.filter((k) => !ids.has(k));
    if (missing.length > 0) {
      report.resources.failed.push({ key: planned.key, reason: `depends on unresolved ${missing.join(', ')}` });
      continue;
    }
    await ensureResource(run, planned, ids, report.resources);
  }

  // 2. Leave blocks.
  for (const block of plan.blocks) {
    const scheduleId = ids.get(block.scheduleKey);
    if (scheduleId === undefined) report.blocks.failed.push({ key: block.key, reason: `depends on unresolved ${block.scheduleKey}` });
    else await syncBlock(run, block, scheduleId, report.blocks);
  }

  // 3. Future appointments of the seeded patients: the seed's own (by marker) and everything else.
  const from = now();
  const seeded: SeedAppointment[] = [];
  let notSeeded = 0;
  const unlisted = new Map<string, string>(); // patient key → why its appointments are unknown
  for (const p of dataset.patients) {
    const patientId = ids.get(`patient:${p.key}`);
    if (patientId === undefined) {
      unlisted.set(p.key, `depends on unresolved patient:${p.key}`);
      continue;
    }
    try {
      for (const appointment of await futureAppointments(run, patientId, from)) {
        const key = seedAppointmentKey(appointment);
        if (key !== undefined && typeof appointment['id'] === 'string') seeded.push({ key, id: appointment['id'] });
        else notSeeded += 1;
      }
    } catch (err) {
      unlisted.set(p.key, `could not list the patient's appointments: ${messageOf(err)}`);
    }
  }

  // Keys whose state this run could not establish: never booked again in this run.
  const unresolvedKeys = new Set<string>();
  if (options.resetAppointments) {
    report.reset = await resetSeedAppointments(run, seeded, notSeeded, unlisted, unresolvedKeys);
  }

  // 4. Appointments.
  for (const planned of plan.appointments) {
    await bookPlanned(run, planned, ids, seeded, unlisted, unresolvedKeys, report.appointments);
  }

  // 5. Free time per practitioner and service (a check, not an operation).
  const verifyFrom = now();
  for (const p of dataset.practitioners) {
    for (const serviceKey of p.serviceKeys) {
      const serviceId = ids.get(`service:${serviceKey}`);
      const practitionerId = ids.get(`practitioner:${p.key}`);
      if (serviceId === undefined || practitionerId === undefined) {
        report.verification.push({ practitionerKey: p.key, serviceKey, hasFreeTime: false, error: 'not checked: practitioner or service unresolved' });
        continue;
      }
      try {
        const { slots } = await scheduling.findAvailability(run.op(), {
          serviceId,
          practitionerIds: [practitionerId],
          from: verifyFrom,
          to: new Date(verifyFrom.getTime() + 14 * 86_400_000),
          limit: 1,
        });
        report.verification.push({ practitionerKey: p.key, serviceKey, hasFreeTime: slots.length > 0 });
      } catch (err) {
        // A failed check is reported, not fatal: the resources and bookings above are already written.
        report.verification.push({ practitionerKey: p.key, serviceKey, hasFreeTime: false, error: messageOf(err) });
      }
    }
  }

  const issues = [report.resources, report.blocks, report.appointments, ...(report.reset ? [report.reset] : [])];
  report.complete = issues.every((section) => section.failed.length === 0 && section.uncertain.length === 0);
  deps.log.info('seed.applied', {
    complete: report.complete,
    resources_created: report.resources.created.length,
    resources_existing: report.resources.existing.length,
    blocks_created: report.blocks.created.length,
    blocks_moved: report.blocks.moved.length,
    booked: report.appointments.booked.length,
    unmarked: report.appointments.unmarked.length,
    cancelled: report.reset?.cancelled.length ?? 0,
    failed: issues.reduce((n, s) => n + s.failed.length, 0),
    uncertain: issues.reduce((n, s) => n + s.uncertain.length, 0),
  });
  return report;
}

/** Finds the resource by its seed key, or creates it (conditional create). Records the outcome. */
async function ensureResource(run: SeedRun, planned: PlannedResource, ids: Map<string, string>, out: SeedReport['resources']): Promise<void> {
  const { key } = planned;
  let found: Record<string, unknown>[];
  try {
    found = await findSeeded(run, planned.resourceType, key);
  } catch (err) {
    out.failed.push({ key, reason: `lookup failed: ${messageOf(err)}` });
    return;
  }
  if (found.length > 1) {
    out.failed.push({ key, reason: `${found.length} resources carry this seed key; resolve the duplicates manually` });
    return;
  }
  const existingId = idOf(found[0]);
  if (existingId !== undefined) {
    ids.set(key, existingId);
    out.existing.push(key);
    return;
  }
  try {
    const response = await run.client.write('POST', planned.resourceType, resolveSeedReferences(planned.resource, ids), run.op().signal, { 'If-None-Exist': seedCondition(key) });
    const id = idOf(asRecord(response.json));
    if (id === undefined) throw new ProviderError(MEDPLUM, 'bad_response', 'Create response has no id');
    ids.set(key, id);
    // 200: the conditional create found a match (created meanwhile, e.g. by a concurrent run).
    (response.status === 201 ? out.created : out.existing).push(key);
  } catch (err) {
    if (isDefinitive(err)) {
      out.failed.push({ key, reason: messageOf(err) });
      return;
    }
    // The create may have been applied: look once more.
    const again = await findSeeded(run, planned.resourceType, key).catch(() => undefined);
    const id = again?.length === 1 ? idOf(again[0]) : undefined;
    if (id !== undefined) {
      ids.set(key, id);
      out.created.push(key);
    } else {
      out.uncertain.push({ key, reason: `${messageOf(err)}; not found afterwards` });
    }
  }
}

/**
 * One `busy-unavailable` Slot per block seed key: created if missing, moved in place when the plan's dates
 * differ (the anchor day changed), left alone otherwise. A move is a version-checked update (`If-Match`)
 * that changes only the fields the seed manages. Re-running never adds a second block.
 */
async function syncBlock(run: SeedRun, block: PlannedBlock, scheduleId: string, out: SeedReport['blocks']): Promise<void> {
  const schedule = `Schedule/${scheduleId}`;
  const managed = { schedule: { reference: schedule }, status: 'busy-unavailable', start: block.start, end: block.end, comment: block.reason };
  let found: Record<string, unknown>[];
  try {
    found = await findSeeded(run, 'Slot', block.key);
  } catch (err) {
    out.failed.push({ key: block.key, reason: `lookup failed: ${messageOf(err)}` });
    return;
  }
  if (found.length > 1) {
    out.failed.push({ key: block.key, reason: `${found.length} Slots carry this seed key; resolve the duplicates manually` });
    return;
  }
  const [current] = found;

  if (current === undefined) {
    const resource = { resourceType: 'Slot', meta: { tag: [SYNTHETIC_TAG] }, identifier: [{ system: SEED_KEY_SYSTEM, value: block.key }], ...managed };
    try {
      await run.client.write('POST', 'Slot', resource, run.op().signal, { 'If-None-Exist': seedCondition(block.key) });
      out.created.push(block.key);
    } catch (err) {
      if (isDefinitive(err)) {
        out.failed.push({ key: block.key, reason: messageOf(err) });
        return;
      }
      const again = await findSeeded(run, 'Slot', block.key).catch(() => undefined);
      if (again?.length === 1) out.created.push(block.key);
      else out.uncertain.push({ key: block.key, reason: `${messageOf(err)}; not found afterwards` });
    }
    return;
  }

  if (!hasSyntheticTag(current)) {
    out.failed.push({ key: block.key, reason: 'carries the seed key but not the synthetic tag: ownership unclear, left unchanged' });
    return;
  }
  const inPlace = (slot: Record<string, unknown>): boolean =>
    sameInstant(slot['start'], block.start) && sameInstant(slot['end'], block.end) && slot['status'] === 'busy-unavailable' && asRecord(slot['schedule'])?.['reference'] === schedule;
  if (inPlace(current)) {
    out.unchanged.push(block.key);
    return;
  }
  const id = idOf(current);
  const version = asRecord(current['meta'])?.['versionId'];
  if (id === undefined || typeof version !== 'string') {
    out.failed.push({ key: block.key, reason: 'no id/version on the stored Slot: cannot update it safely' });
    return;
  }
  try {
    await run.client.write('PUT', `Slot/${encodeURIComponent(id)}`, { ...current, ...managed }, run.op().signal, { 'If-Match': `W/"${version}"` });
    out.moved.push(block.key);
  } catch (err) {
    if (isDefinitive(err)) {
      const conflict = err instanceof SchedulingError && err.kind === 'already_exists'; // 412
      out.failed.push({ key: block.key, reason: conflict ? 'changed since it was read (version conflict); not moved' : messageOf(err) });
      return;
    }
    const again = await findSeeded(run, 'Slot', block.key).catch(() => undefined);
    const stored = again?.length === 1 ? again[0] : undefined;
    if (stored !== undefined && inPlace(stored)) out.moved.push(block.key);
    else out.uncertain.push({ key: block.key, reason: `${messageOf(err)}; move not confirmed` });
  }
}

/**
 * Cancels the seed's own future appointments that are unchanged since the seed booked them. Everything
 * else is kept: appointments the seed did not make, seed appointments changed afterwards (e.g.
 * rescheduled through Mujeeb), and any whose history cannot be read.
 */
async function resetSeedAppointments(
  run: SeedRun,
  seeded: SeedAppointment[],
  notSeeded: number,
  unlisted: ReadonlyMap<string, string>,
  unresolvedKeys: Set<string>,
): Promise<NonNullable<SeedReport['reset']>> {
  const reset: NonNullable<SeedReport['reset']> = { cancelled: [], kept: [], notSeeded, failed: [], uncertain: [] };
  for (const [patientKey, reason] of unlisted) reset.failed.push({ key: `patient:${patientKey}`, reason: `${reason}; nothing cancelled for this patient` });
  for (const appointment of [...seeded]) {
    const unchanged = await unchangedSinceBooking(run, appointment.id);
    if (unchanged !== true) {
      reset.kept.push({ key: appointment.key, reason: unchanged });
      continue;
    }
    try {
      await run.scheduling.cancel(run.op(), { appointmentId: appointment.id, reason: 'seed reset', idempotencyKey: `seed-reset:${appointment.id}` });
      reset.cancelled.push(appointment.key);
      seeded.splice(seeded.indexOf(appointment), 1);
    } catch (err) {
      if (isDefinitive(err)) {
        reset.failed.push({ key: appointment.key, reason: messageOf(err) });
        continue;
      }
      const status = await run.client
        .read(`Appointment/${encodeURIComponent(appointment.id)}`, [], run.op().signal)
        .then((json) => asRecord(json)?.['status'])
        .catch(() => undefined);
      if (status === 'cancelled') {
        reset.cancelled.push(appointment.key);
        seeded.splice(seeded.indexOf(appointment), 1);
      } else if (status === 'booked' || status === 'pending') {
        reset.failed.push({ key: appointment.key, reason: `${messageOf(err)}; still ${status}` });
      } else {
        reset.uncertain.push({ key: appointment.key, reason: `${messageOf(err)}; cancellation not confirmed` });
        unresolvedKeys.add(appointment.key);
      }
    }
  }
  return reset;
}

/** True when the Appointment has exactly one version (nothing changed it after `$book`); otherwise why not. */
async function unchangedSinceBooking(run: SeedRun, appointmentId: string): Promise<true | string> {
  try {
    const parsed = bundleSchema.safeParse(await run.client.read(`Appointment/${encodeURIComponent(appointmentId)}/_history`, [], run.op().signal));
    if (!parsed.success) return 'history unreadable: state unclear';
    const versions = parsed.data.entry.length;
    const more = parsed.data.link.some((l) => l.relation === 'next');
    if (versions === 1 && !more) return true;
    return versions === 0 ? 'history is empty: state unclear' : 'changed since the seed booked it';
  } catch (err) {
    return `history unavailable (${messageOf(err)}): state unclear`;
  }
}

async function bookPlanned(
  run: SeedRun,
  planned: PlannedAppointment,
  ids: ReadonlyMap<string, string>,
  seeded: readonly SeedAppointment[],
  unlisted: ReadonlyMap<string, string>,
  unresolvedKeys: ReadonlySet<string>,
  out: SeedReport['appointments'],
): Promise<void> {
  const seedKey = `${SEED_APPOINTMENT_PREFIX}${planned.key}`;
  const needed = [`patient:${planned.patientKey}`, `practitioner:${planned.practitionerKey}`, `service:${planned.serviceKey}`];
  const missing = needed.filter((k) => !ids.has(k));
  if (missing.length > 0) {
    out.failed.push({ key: planned.key, reason: `depends on unresolved ${missing.join(', ')}` });
    return;
  }
  const [patientId = '', practitionerId = '', serviceId = ''] = needed.map((k) => ids.get(k));
  const unlistedReason = unlisted.get(planned.patientKey);
  if (unlistedReason !== undefined) {
    out.failed.push({ key: planned.key, reason: `${unlistedReason}; not booked, to avoid a duplicate` });
    return;
  }
  if (unresolvedKeys.has(seedKey)) {
    out.uncertain.push({ key: planned.key, reason: 'the reset of this appointment is not confirmed; not booked again' });
    return;
  }
  // At most one upcoming seed appointment per key, whichever day an earlier run put it on.
  if (seeded.some((a) => a.key === seedKey)) {
    out.alreadyPresent.push(planned.key);
    return;
  }

  const start = new Date(planned.start);
  let slot: AvailableSlot | undefined;
  try {
    const existing = await run.scheduling.listAppointments(run.op(), { patientId, from: start });
    if (existing.some((a) => a.start.getTime() === start.getTime() && a.practitionerId === practitionerId)) {
      out.alreadyPresent.push(planned.key);
      return;
    }
    const { slots } = await run.scheduling.findAvailability(run.op(), {
      serviceId,
      practitionerIds: [practitionerId],
      from: start,
      to: new Date(start.getTime() + (planned.durationMinutes + 1) * 60_000),
      limit: 5,
    });
    slot = slots.find((s) => s.start.getTime() === start.getTime());
  } catch (err) {
    out.failed.push({ key: planned.key, reason: `lookup failed: ${messageOf(err)}` });
    return;
  }
  if (!slot) {
    out.failed.push({ key: planned.key, reason: 'time not offered by $find' });
    return;
  }

  try {
    const booked = await run.scheduling.bookMarked(
      run.op(),
      { patientId, slot, idempotencyKey: `seed:${planned.key}:${planned.date}` },
      { identifiers: [{ system: SEED_KEY_SYSTEM, value: seedKey }], tags: [SYNTHETIC_TAG] },
    );
    out.booked.push(planned.key);
    if (!(await keepsSeedKey(run, booked.id, seedKey))) out.unmarked.push(planned.key);
  } catch (err) {
    if (isDefinitive(err)) {
      out.failed.push({ key: planned.key, reason: messageOf(err) });
      return;
    }
    // The booking may have been applied: look for it once (by marker, or by time and practitioner).
    const applied = await futureAppointments(run, patientId, start)
      .then((list) => list.some((a) => seedAppointmentKey(a) === seedKey || (sameInstant(a['start'], planned.start) && hasParticipant(a, `Practitioner/${practitionerId}`))))
      .catch(() => undefined);
    if (applied === true) out.booked.push(planned.key);
    else if (applied === false) out.failed.push({ key: planned.key, reason: `${messageOf(err)}; checked: not booked` });
    else out.uncertain.push({ key: planned.key, reason: `${messageOf(err)}; booking not confirmed` });
  }
}

// ─────────────────────────────── helpers ───────────────────────────────

/** Resources of `type` carrying exactly this seed key (checked here too, not only by the server's search). */
async function findSeeded(run: SeedRun, type: string, key: string): Promise<Record<string, unknown>[]> {
  const found = await search(run, type, [['identifier', `${SEED_KEY_SYSTEM}|${key}`]]);
  return found.filter((r) => seedKeyOf(r) === key);
}

/** Booked or pending appointments of a patient starting at or after `from`. */
async function futureAppointments(run: SeedRun, patientId: string, from: Date): Promise<Record<string, unknown>[]> {
  const found = await search(run, 'Appointment', [
    ['patient', `Patient/${patientId}`],
    ['date', `ge${from.toISOString()}`],
  ]);
  return found.filter((a) => (a['status'] === 'booked' || a['status'] === 'pending') && Date.parse(String(a['start'])) >= from.getTime());
}

/** The seed key of an appointment the seed booked itself: it must carry both the seed key and the synthetic tag. */
export function seedAppointmentKey(appointment: Record<string, unknown>): string | undefined {
  const key = seedKeyOf(appointment);
  return key !== undefined && key.startsWith(SEED_APPOINTMENT_PREFIX) && hasSyntheticTag(appointment) ? key : undefined;
}

/** Whether Medplum kept the seed markers on a booked appointment (so a later reset can find it). */
async function keepsSeedKey(run: SeedRun, appointmentId: string, key: string): Promise<boolean> {
  try {
    const stored = asRecord(await run.client.read(`Appointment/${encodeURIComponent(appointmentId)}`, [], run.op().signal));
    return stored !== undefined && seedAppointmentKey(stored) === key;
  } catch {
    return false; // cannot confirm: reported as unmarked
  }
}

/** Search results of one type across a few pages. Fails rather than act on an incomplete listing. */
async function search(run: SeedRun, type: string, query: [string, string][]): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  let json = await run.client.read(type, [...query, ['_count', String(SEARCH_PAGE_SIZE)]], run.op().signal);
  for (let page = 1; ; page += 1) {
    const parsed = bundleSchema.safeParse(json);
    if (!parsed.success) throw new ProviderError(MEDPLUM, 'bad_response', `Unexpected ${type} search response`);
    // Search bundles may also carry OperationOutcome entries: keep resources of the asked type only.
    for (const entry of parsed.data.entry) {
      const resource = asRecord(entry.resource);
      if (resource?.['resourceType'] === type) out.push(resource);
    }
    const next = parsed.data.link.find((l) => l.relation === 'next')?.url;
    if (next === undefined) return out;
    if (page >= MAX_SEARCH_PAGES) throw new ProviderError(MEDPLUM, 'bad_response', `${type} search has more than ${MAX_SEARCH_PAGES} pages`);
    json = await run.client.readLink(next, run.op().signal);
  }
}

/** `Type?identifier=<seed system>|<key>`: how the plan refers to a seeded resource before its ID is known. */
export function seedReference(type: string, key: string): string {
  return `${type}?identifier=${SEED_KEY_SYSTEM}|${key}`;
}

function parseSeedReference(reference: string): { type: string; key: string } | undefined {
  const marker = `?identifier=${SEED_KEY_SYSTEM}|`;
  const at = reference.indexOf(marker);
  return at > 0 ? { type: reference.slice(0, at), key: reference.slice(at + marker.length) } : undefined;
}

/** Every seed reference (`reference` element) inside a resource. */
function seedReferencesIn(value: unknown): { type: string; key: string }[] {
  if (Array.isArray(value)) return value.flatMap(seedReferencesIn);
  const record = asRecord(value);
  if (record === undefined) return [];
  return Object.entries(record).flatMap(([name, v]) => {
    const ref = name === 'reference' && typeof v === 'string' ? parseSeedReference(v) : undefined;
    return ref ? [ref] : seedReferencesIn(v);
  });
}

/** A copy of the resource with every seed reference replaced by the real `Type/<id>`. */
function resolveSeedReferences(value: unknown, ids: ReadonlyMap<string, string>): unknown {
  if (Array.isArray(value)) return value.map((v) => resolveSeedReferences(v, ids));
  const record = asRecord(value);
  if (record === undefined) return value;
  const out: Record<string, unknown> = {};
  for (const [name, v] of Object.entries(record)) {
    const ref = name === 'reference' && typeof v === 'string' ? parseSeedReference(v) : undefined;
    if (ref === undefined) {
      out[name] = resolveSeedReferences(v, ids);
      continue;
    }
    const id = ids.get(ref.key);
    if (id === undefined) throw new Error(`Unresolved seed reference '${ref.key}'`); // dependsOn is checked first
    out[name] = `${ref.type}/${id}`;
  }
  return out;
}

function seedCondition(key: string): string {
  return `identifier=${encodeURIComponent(SEED_KEY_SYSTEM)}|${encodeURIComponent(key)}`;
}

function seedKeyOf(resource: Record<string, unknown>): string | undefined {
  const identifiers = resource['identifier'];
  if (!Array.isArray(identifiers)) return undefined;
  const value = identifiers.map((i) => asRecord(i)).find((i) => i?.['system'] === SEED_KEY_SYSTEM)?.['value'];
  return typeof value === 'string' ? value : undefined;
}

function hasSyntheticTag(resource: Record<string, unknown>): boolean {
  const tags = asRecord(resource['meta'])?.['tag'];
  return Array.isArray(tags) && tags.some((t) => asRecord(t)?.['system'] === SYNTHETIC_TAG.system && asRecord(t)?.['code'] === SYNTHETIC_TAG.code);
}

function hasParticipant(appointment: Record<string, unknown>, reference: string): boolean {
  const participants = appointment['participant'];
  return Array.isArray(participants) && participants.some((p) => asRecord(asRecord(p)?.['actor'])?.['reference'] === reference);
}

function idOf(resource: Record<string, unknown> | undefined): string | undefined {
  const id = resource?.['id'];
  return typeof id === 'string' && id !== '' ? id : undefined;
}

/** True when the system definitely did not apply the write (a business answer, or a request refused up front). */
function isDefinitive(err: unknown): boolean {
  if (err instanceof SchedulingError) return true;
  return err instanceof ProviderError && DEFINITIVE_PROVIDER_FAILURES.has(err.kind);
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sameInstant(value: unknown, iso: string): boolean {
  return typeof value === 'string' && Date.parse(value) === Date.parse(iso);
}

function asIdentifiers(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
