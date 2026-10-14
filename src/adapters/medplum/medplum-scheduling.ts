import type { z } from 'zod';
import { abortReason } from '../../core/async.js';
import { ProviderError, SchedulingError, type SchedulingErrorKind } from '../../core/errors.js';
import { isNationalIdFormat } from '../../core/identifiers.js';
import { canonicalPhone, isCanonicalPhone, phoneSearchForms, samePhone } from '../../core/phone.js';
import { rankByText } from '../../core/text-match.js';
import { isLocalDate } from '../../core/zoned-time.js';
import {
  type AppointmentListQuery,
  type AppointmentRecord,
  type AppointmentStatus,
  type AvailabilityQuery,
  type AvailabilityResult,
  type AvailableSlot,
  type BookingRequest,
  type CancelRequest,
  type DirectoryEntry,
  type DirectorySearchQuery,
  type DirectorySearchResult,
  type Gender,
  MAX_AVAILABILITY_WINDOW_DAYS,
  MAX_RESULTS_LIMIT,
  type PatientLookup,
  type PatientRecord,
  type RegisterPatientRequest,
  type RescheduleRequest,
  type SchedulingContext,
  type SchedulingSystem,
} from '../../ports/scheduling.js';
import { MEDPLUM, type MedplumClient } from './client.js';
import {
  CANCELLATION_REASON_SYSTEM,
  type FhirAppointment,
  type FhirPatient,
  SERVICE_TYPE_REFERENCE_EXTENSION,
  allNames,
  appointmentSchema,
  asRecord,
  bundleSchema,
  displayName,
  healthcareServiceSchema,
  idFromReference,
  parametersSchema,
  patientSchema,
  practitionerSchema,
  referencedServiceIds,
  scheduleSchema,
  schedulingDurationMinutes,
} from './fhir-schemas.js';

/**
 * `SchedulingSystem` on Medplum's scheduling API (Beta): `Appointment/$find`, `$book`, `$reschedule`,
 * `$cancel`, plus FHIR searches. Medplum is a temporary sandbox (DECISIONS A15); nothing outside this
 * folder knows about it.
 *
 * Contract details that matter:
 * - Several `schedule` parameters in one `$find` mean "all of these resources together" (intersection),
 *   so availability for "any practitioner of a service" is one `$find` per Schedule, merged here.
 * - `$book` takes the proposed Appointment from `$find` (+ the patient) and answers with a Bundle;
 *   `$reschedule` takes the new start and the complete destination schedule set (schedules left out are
 *   removed) and answers with a Bundle; `$cancel` answers with the Appointment itself.
 * - Writes are sent once. Ambiguous failures surface as ProviderError for the caller to reconcile.
 * - The clinic directory (services, schedules, practitioners) is cached for `directoryTtlMs`.
 */

export const IDEMPOTENCY_KEY_SYSTEM = 'urn:mujeeb:idempotency-key';

const DAY_MS = 86_400_000;
/** Slot length assumed when a service does not state its duration. */
const DEFAULT_SLOT_MINUTES = 60;
const PAGE_SIZE = 100;
const MAX_PAGES = 5;
const ACTIVE: ReadonlySet<AppointmentStatus> = new Set(['booked', 'pending']);
const FHIR_STATUS: ReadonlySet<string> = new Set(['pending', 'booked', 'cancelled', 'fulfilled', 'noshow']);

export interface MedplumSchedulingOptions {
  /** The only tenant this instance serves (one Medplum project per tenant). */
  tenantId: string;
  client: MedplumClient;
  /** Identifier system under which this HIS stores national ID / Iqama numbers. */
  nationalIdSystem: string;
  directoryTtlMs?: number;
  /** Parallel `$find` calls when searching several practitioners. */
  maxParallelFinds?: number;
  now?: () => Date;
}

interface DirService {
  id: string;
  name: string;
  searchText: string;
  durationMinutes?: number;
}

interface DirPractitioner {
  id: string;
  name: string;
  gender: Gender;
  searchText: string;
  serviceIds: string[];
}

interface DirSchedule {
  id: string;
  practitionerId: string;
  serviceIds: string[];
}

interface Directory {
  loadedAt: number;
  services: Map<string, DirService>;
  practitioners: Map<string, DirPractitioner>;
  schedules: DirSchedule[];
}

/** Server-side only: everything needed to commit (or reschedule to) exactly this proposed time. */
interface SlotToken {
  v: 1;
  schedule: string;
  practitioner: string;
  service: string;
  start: string;
  appointment: Record<string, unknown>;
}

type DirectoryItem = { kind: 'service'; service: DirService } | { kind: 'practitioner'; practitioner: DirPractitioner };

/** Extra identifiers and tags stamped on a booked Appointment (the sandbox seed marks its own appointments). */
export interface AppointmentMarkers {
  readonly identifiers?: readonly { readonly system: string; readonly value: string }[];
  readonly tags?: readonly { readonly system: string; readonly code: string; readonly display?: string }[];
}

export class MedplumSchedulingSystem implements SchedulingSystem {
  readonly name = MEDPLUM;
  /** `$book` is sent our idempotency identifier, but whether it is kept and honoured is unverified (plan step 7). */
  readonly capabilities = { idempotencyKeys: false } as const;

  private readonly o: Required<MedplumSchedulingOptions>;
  private dir: Directory | undefined;

  constructor(options: MedplumSchedulingOptions) {
    this.o = { directoryTtlMs: 300_000, maxParallelFinds: 4, now: () => new Date(), ...options };
  }

  // ─────────────────────────────── directory ───────────────────────────────

  async searchDirectory(ctx: SchedulingContext, query: DirectorySearchQuery): Promise<DirectorySearchResult> {
    this.enter(ctx);
    checkLimit(query.limit);
    let dir = await this.directory(ctx);
    if (query.serviceId !== undefined && !dir.services.has(query.serviceId)) {
      dir = await this.directory(ctx, true);
      if (!dir.services.has(query.serviceId)) throw schedulingError('not_found', 'Service not found');
    }
    const items: DirectoryItem[] = [];
    if (query.kind !== 'practitioner') {
      for (const service of dir.services.values()) if (query.serviceId === undefined || service.id === query.serviceId) items.push({ kind: 'service', service });
    }
    if (query.kind !== 'service') {
      for (const practitioner of dir.practitioners.values()) {
        if (query.serviceId === undefined || practitioner.serviceIds.includes(query.serviceId)) items.push({ kind: 'practitioner', practitioner });
      }
    }
    const text = query.text?.trim() ?? '';
    const ranked =
      text === ''
        ? items.map((item) => ({ item, score: 1 }))
        : rankByText(text, items, (item) => [item.kind === 'service' ? item.service.searchText : item.practitioner.searchText]);
    return { entries: ranked.slice(0, query.limit).map(({ item, score }) => toEntry(item, score, dir)), hasMore: ranked.length > query.limit };
  }

  // ─────────────────────────────── availability ───────────────────────────────

  async findAvailability(ctx: SchedulingContext, query: AvailabilityQuery): Promise<AvailabilityResult> {
    this.enter(ctx);
    checkLimit(query.limit);
    const from = query.from.getTime();
    const to = query.to.getTime();
    if (Number.isNaN(from) || Number.isNaN(to) || from >= to) throw schedulingError('invalid_request', 'Availability window must have from < to');
    if (to - from > MAX_AVAILABILITY_WINDOW_DAYS * DAY_MS) throw schedulingError('invalid_request', `Availability window exceeds ${MAX_AVAILABILITY_WINDOW_DAYS} days`);

    let dir = await this.directory(ctx);
    if (!dir.services.has(query.serviceId)) dir = await this.directory(ctx, true);
    const service = dir.services.get(query.serviceId);
    if (!service) throw schedulingError('not_found', 'Service not found');
    if (query.practitionerIds !== undefined) {
      if (query.practitionerIds.length === 0) throw schedulingError('invalid_request', 'practitionerIds must not be empty when given');
      for (const id of query.practitionerIds) {
        const practitioner = dir.practitioners.get(id);
        if (!practitioner) throw schedulingError('not_found', 'Practitioner not found');
        if (!practitioner.serviceIds.includes(service.id)) throw schedulingError('invalid_request', 'A requested practitioner does not offer this service');
      }
    }
    if (query.ignoreAppointmentId !== undefined) await this.readAppointment(ctx, query.ignoreAppointmentId);

    const schedules = dir.schedules.filter(
      (s) => s.serviceIds.includes(service.id) && (query.practitionerIds === undefined || query.practitionerIds.includes(s.practitionerId)),
    );
    const now = this.o.now().getTime();
    const start = new Date(Math.max(from, now + 1));
    if (start.getTime() >= to) return { slots: [], hasMore: false };
    // $find returns only slots that fit entirely inside [start, end], while the port asks for slots *starting*
    // in [from, to) (observed live, plan step 7): ask one slot length further and keep the starts before `to`.
    const end = new Date(to + (service.durationMinutes ?? DEFAULT_SLOT_MINUTES) * 60_000);
    // One $find per Schedule: several `schedule` parameters would ask for times when ALL are free together.
    const perSchedule = await mapLimit(schedules, this.o.maxParallelFinds, (schedule) =>
      this.find(ctx, dir, schedule, service, start, end, query.limit + 1, query.ignoreAppointmentId),
    );
    const inWindow = perSchedule.map((list) => list.filter((s) => s.start.getTime() > now && s.start.getTime() >= start.getTime() && s.start.getTime() < to));
    const slots = inWindow.flat().sort((a, b) => a.start.getTime() - b.start.getTime() || a.practitionerName.localeCompare(b.practitionerName));
    return { slots: slots.slice(0, query.limit), hasMore: slots.length > query.limit || inWindow.some((list) => list.length > query.limit) };
  }

  // ─────────────────────────────── patients ───────────────────────────────

  async findPatients(ctx: SchedulingContext, lookup: PatientLookup): Promise<readonly PatientRecord[]> {
    this.enter(ctx);
    if (lookup.nationalId === undefined && lookup.phone === undefined) throw schedulingError('invalid_request', 'Patient lookup needs a national ID or a phone number');
    if (lookup.nationalId !== undefined && !isNationalIdFormat(lookup.nationalId)) throw schedulingError('invalid_request', 'National ID is not in canonical form');
    if (lookup.phone !== undefined && !isCanonicalPhone(lookup.phone)) throw schedulingError('invalid_request', 'Phone is not in canonical form');
    const query: [string, string][] = [];
    if (lookup.nationalId !== undefined) query.push(['identifier', `${this.o.nationalIdSystem}|${lookup.nationalId}`]);
    // Medplum's `phone` search matches the stored text exactly, and stored formats vary (05…, 9665…, "+966 5…"):
    // one OR search over the usual written forms (no scan), then a canonical comparison of every phone on the record.
    if (lookup.phone !== undefined) query.push(['phone', phoneSearchForms(lookup.phone).join(',')]);
    const patients = await this.searchAll('Patient', query, patientSchema, ctx.signal);
    return patients
      .filter((p) => lookup.phone === undefined || phonesOf(p).some((value) => samePhone(value, lookup.phone)))
      .map((p) => this.toPatient(p, lookup.phone))
      .filter((p) => lookup.nationalId === undefined || p.nationalId === lookup.nationalId);
  }

  async registerPatient(ctx: SchedulingContext, request: RegisterPatientRequest): Promise<PatientRecord> {
    this.enter(ctx);
    checkKey(request.idempotencyKey);
    const p = request.patient;
    if (p.fullName.trim() === '') throw schedulingError('invalid_request', 'Full name is required');
    if (!isNationalIdFormat(p.nationalId)) throw schedulingError('invalid_request', 'National ID is not in canonical form');
    if (!isCanonicalPhone(p.phone)) throw schedulingError('invalid_request', 'Phone is not in canonical form');
    if (!isLocalDate(p.birthDate) || p.birthDate > this.o.now().toISOString().slice(0, 10)) throw schedulingError('invalid_request', 'Birth date is invalid');
    const [given, ...rest] = p.fullName.trim().split(/\s+/);
    const resource = {
      resourceType: 'Patient',
      active: true,
      name: [{ text: p.fullName.trim(), given: [given ?? ''], ...(rest.length > 0 ? { family: rest.join(' ') } : {}) }],
      birthDate: p.birthDate,
      gender: p.gender,
      telecom: [{ system: 'phone', value: p.phone, use: 'mobile' }],
      identifier: [
        { system: this.o.nationalIdSystem, value: p.nationalId },
        { system: IDEMPOTENCY_KEY_SYSTEM, value: request.idempotencyKey },
      ],
    };
    // Conditional create: an existing record with this national ID is returned (200) instead of a duplicate.
    const response = await this.o.client.write('POST', 'Patient', resource, ctx.signal, {
      'If-None-Exist': `identifier=${encodeURIComponent(this.o.nationalIdSystem)}|${encodeURIComponent(p.nationalId)}`,
    });
    const patient = parse(patientSchema, response.json, 'Patient create');
    if (response.status === 201) return this.toPatient(patient);
    const ours = patient.identifier?.some((i) => i.system === IDEMPOTENCY_KEY_SYSTEM && i.value === request.idempotencyKey);
    if (ours) return this.toPatient(patient); // replay of our own earlier request
    throw schedulingError('already_exists', 'A patient with this national ID is already registered');
  }

  // ─────────────────────────────── appointments ───────────────────────────────

  async getAppointment(ctx: SchedulingContext, appointmentId: string): Promise<AppointmentRecord> {
    this.enter(ctx);
    const [raw, dir] = await Promise.all([this.readAppointment(ctx, appointmentId), this.directory(ctx)]);
    return toRecord(raw, dir);
  }

  async listAppointments(ctx: SchedulingContext, query: AppointmentListQuery): Promise<readonly AppointmentRecord[]> {
    this.enter(ctx);
    const from = query.from ?? this.o.now();
    const statuses = new Set(query.statuses ?? ACTIVE);
    const fhirStatuses = [...statuses].filter((s) => FHIR_STATUS.has(s));
    const [, raws, dir] = await Promise.all([
      this.o.client.read(`Patient/${encodeURIComponent(query.patientId)}`, [], ctx.signal), // not_found for an unknown patient
      this.searchAll(
        'Appointment',
        [
          ['patient', `Patient/${query.patientId}`],
          ['date', `ge${from.toISOString()}`],
          // Never send an empty `status=`; "other" has no FHIR code and is filtered below.
          ...(fhirStatuses.length > 0 ? [['status', fhirStatuses.join(',')] as [string, string]] : []),
          ['_sort', 'date'],
        ],
        appointmentSchema,
        ctx.signal,
      ),
      this.directory(ctx),
    ]);
    return raws
      .map((raw) => toRecord(raw, dir))
      .filter((a) => statuses.has(a.status) && a.start.getTime() >= from.getTime())
      .sort((a, b) => a.start.getTime() - b.start.getTime());
  }

  async book(ctx: SchedulingContext, request: BookingRequest): Promise<AppointmentRecord> {
    return this.bookMarked(ctx, request, {});
  }

  /** `book` that also stamps `markers` on the Appointment. Medplum-only (used by the seed); not part of the port. */
  async bookMarked(ctx: SchedulingContext, request: BookingRequest, markers: AppointmentMarkers): Promise<AppointmentRecord> {
    this.enter(ctx);
    checkKey(request.idempotencyKey);
    const token = decodeToken(request.slot);
    const appointment = withPatient(token, request.patientId, request.idempotencyKey, markers);
    // Everything that can fail on its own happens before the write, so a committed write never looks failed.
    const [dir] = await Promise.all([
      this.directory(ctx),
      this.o.client.read(`Patient/${encodeURIComponent(request.patientId)}`, [], ctx.signal), // not_found for an unknown patient
    ]);
    // Medplum re-checks availability inside one SERIALIZABLE transaction: a taken time answers "not available".
    const response = await this.o.client.write('POST', 'Appointment/$book', { resourceType: 'Parameters', parameter: [{ name: 'appointment', resource: appointment }] }, ctx.signal);
    return toRecord(appointmentFrom(response.json, '$book'), dir);
  }

  async reschedule(ctx: SchedulingContext, request: RescheduleRequest): Promise<AppointmentRecord> {
    this.enter(ctx);
    checkKey(request.idempotencyKey);
    const token = decodeToken(request.newSlot);
    const [current, dir] = await Promise.all([this.readAppointment(ctx, request.appointmentId), this.directory(ctx)]);
    const status = toStatus(current.status);
    if (!ACTIVE.has(status)) throw schedulingError('invalid_state', `Appointment cannot be rescheduled in '${current.status}' status`);
    const currentService = referencedServiceIds(current.serviceType)[0];
    if (currentService !== undefined && currentService !== token.service) throw schedulingError('invalid_request', 'Rescheduling cannot change the service; cancel and book instead');
    const otherResources = current.participant.filter((p) => {
      const ref = p.actor?.reference;
      return ref !== undefined && idFromReference(ref, 'Patient') === undefined && idFromReference(ref, 'Practitioner') === undefined;
    });
    // $reschedule replaces the whole schedule set; appointments that also hold rooms/devices would lose them.
    if (otherResources.length > 0) throw schedulingError('invalid_request', 'Appointments that hold more than one practitioner schedule are not supported');
    const destination = destinationSchedules(token);
    const response = await this.o.client.write(
      'POST',
      `Appointment/${encodeURIComponent(request.appointmentId)}/$reschedule`,
      {
        resourceType: 'Parameters',
        parameter: [{ name: 'start', valueDateTime: token.start }, ...destination.map((id) => ({ name: 'schedule', valueReference: { reference: `Schedule/${id}` } }))],
      },
      ctx.signal,
    );
    return toRecord(appointmentFrom(response.json, '$reschedule'), dir);
  }

  async cancel(ctx: SchedulingContext, request: CancelRequest): Promise<AppointmentRecord> {
    this.enter(ctx);
    checkKey(request.idempotencyKey);
    const reason = request.reason?.trim();
    // Before the write (see book()). The state is checked here, as for reschedule: Medplum loads the
    // appointment's Slots first, so cancelling one whose Slots are gone (already cancelled) answers
    // "Loading slots failed" instead of a state error (observed live, plan step 7).
    const [current, dir] = await Promise.all([this.readAppointment(ctx, request.appointmentId), this.directory(ctx)]);
    if (!ACTIVE.has(toStatus(current.status))) throw schedulingError('invalid_state', `Appointment cannot be cancelled in '${current.status}' status`);
    const response = await this.o.client.write(
      'POST',
      `Appointment/${encodeURIComponent(request.appointmentId)}/$cancel`,
      {
        resourceType: 'Parameters',
        parameter: [
          {
            name: 'cancelationReason',
            valueCodeableConcept: { coding: [{ system: CANCELLATION_REASON_SYSTEM, code: 'pat' }], ...(reason ? { text: reason } : {}) },
          },
        ],
      },
      ctx.signal,
    );
    return toRecord(appointmentFrom(response.json, '$cancel'), dir);
  }

  // ─────────────────────────────── internals ───────────────────────────────

  private enter(ctx: SchedulingContext): void {
    if (ctx.tenant.tenantId !== this.o.tenantId) {
      throw new ProviderError(MEDPLUM, 'auth', 'Scheduling system is not configured for this tenant', { retryable: false });
    }
    if (ctx.signal.aborted) throw abortReason(ctx.signal);
  }

  private async directory(ctx: SchedulingContext, refresh = false): Promise<Directory> {
    if (!refresh && this.dir && this.o.now().getTime() - this.dir.loadedAt < this.o.directoryTtlMs) return this.dir;
    this.dir = await this.loadDirectory(ctx.signal);
    return this.dir;
  }

  private async loadDirectory(signal: AbortSignal): Promise<Directory> {
    const [rawServices, rawSchedules] = await Promise.all([
      this.searchAll('HealthcareService', [['active', 'true']], healthcareServiceSchema, signal),
      this.searchAll('Schedule', [['active', 'true']], scheduleSchema, signal),
    ]);
    const services = new Map<string, DirService>();
    for (const hs of rawServices) {
      const name = hs.name?.trim() || hs.type?.[0]?.text?.trim() || hs.id;
      const texts = [name, ...(hs.type ?? []).flatMap((t) => [t.text ?? '', ...(t.coding ?? []).map((c) => c.display ?? '')]), ...(hs.specialty ?? []).map((s) => s.text ?? '')];
      const duration = schedulingDurationMinutes(hs);
      services.set(hs.id, { id: hs.id, name, searchText: texts.filter((t) => t !== '').join(' '), ...(duration !== undefined ? { durationMinutes: duration } : {}) });
    }
    const schedules: DirSchedule[] = [];
    for (const s of rawSchedules) {
      const practitionerId = s.actor.map((a) => idFromReference(a.reference, 'Practitioner')).find((id) => id !== undefined);
      const serviceIds = referencedServiceIds(s.serviceType).filter((id) => services.has(id));
      if (practitionerId !== undefined && serviceIds.length > 0) schedules.push({ id: s.id, practitionerId, serviceIds });
    }
    const practitionerIds = [...new Set(schedules.map((s) => s.practitionerId))];
    const rawPractitioners = practitionerIds.length > 0 ? await this.searchAll('Practitioner', [['_id', practitionerIds.join(',')]], practitionerSchema, signal) : [];
    const practitioners = new Map<string, DirPractitioner>();
    for (const p of rawPractitioners) {
      const serviceIds = [...new Set(schedules.filter((s) => s.practitionerId === p.id).flatMap((s) => s.serviceIds))];
      practitioners.set(p.id, {
        id: p.id,
        name: displayName(p.name) || p.id,
        gender: p.gender === 'female' || p.gender === 'male' ? p.gender : 'unknown',
        searchText: [...allNames(p.name), ...serviceIds.map((id) => services.get(id)?.searchText ?? '')].join(' '),
        serviceIds,
      });
    }
    return { loadedAt: this.o.now().getTime(), services, practitioners, schedules: schedules.filter((s) => practitioners.has(s.practitionerId)) };
  }

  private async find(
    ctx: SchedulingContext,
    dir: Directory,
    schedule: DirSchedule,
    service: DirService,
    from: Date,
    to: Date,
    count: number,
    ignoreAppointmentId: string | undefined,
  ): Promise<AvailableSlot[]> {
    const json = await this.o.client.read(
      'Appointment/$find',
      [
        ['start', from.toISOString()],
        ['end', to.toISOString()],
        ['service-type-reference', `HealthcareService/${service.id}`],
        ['schedule', `Schedule/${schedule.id}`],
        ['_count', String(count)],
        ...(ignoreAppointmentId !== undefined ? [['ignore-appointment', `Appointment/${ignoreAppointmentId}`] as [string, string]] : []),
      ],
      ctx.signal,
    );
    // Documented shape: Parameters { return: Bundle }. A bare Bundle is accepted too (the API is Beta).
    const result = asRecord(json)?.['resourceType'] === 'Bundle' ? json : parse(parametersSchema, json, '$find').parameter.find((p) => p.name === 'return')?.resource;
    const bundle = parse(bundleSchema, result, '$find');
    const practitioner = dir.practitioners.get(schedule.practitionerId);
    return resources(bundle, appointmentSchema, 'Appointment').map((raw) => {
      const start = parseInstant(raw.start, '$find');
      const end = parseInstant(raw.end, '$find');
      const token: SlotToken = { v: 1, schedule: schedule.id, practitioner: schedule.practitionerId, service: service.id, start: start.toISOString(), appointment: raw };
      return {
        start,
        end,
        serviceId: service.id,
        serviceName: service.name,
        practitionerId: schedule.practitionerId,
        practitionerName: practitioner?.name ?? '',
        ...(practitioner ? { practitionerGender: practitioner.gender } : {}),
        token: Buffer.from(JSON.stringify(token)).toString('base64url'),
      };
    });
  }

  private async readAppointment(ctx: SchedulingContext, id: string): Promise<FhirAppointment> {
    return parse(appointmentSchema, await this.o.client.read(`Appointment/${encodeURIComponent(id)}`, [], ctx.signal), 'Appointment read');
  }

  /** Search results across a few pages. */
  private async searchAll<S extends z.ZodType>(type: string, query: [string, string][], schema: S, signal: AbortSignal): Promise<z.infer<S>[]> {
    const out: z.infer<S>[] = [];
    let json = await this.o.client.read(type, [...query, ['_count', String(PAGE_SIZE)]], signal);
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const bundle = parse(bundleSchema, json, `${type} search`);
      out.push(...resources(bundle, schema, type));
      const next = bundle.link.find((l) => l.relation === 'next')?.url;
      if (next === undefined || page === MAX_PAGES - 1) break;
      json = await this.o.client.readLink(next, signal);
    }
    return out;
  }

  /** `matchedPhone`: the canonical number the record was found by, reported instead of its stored spelling. */
  private toPatient(p: FhirPatient, matchedPhone?: string): PatientRecord {
    const fullName = displayName(p.name);
    const nationalId = p.identifier?.find((i) => i.system === this.o.nationalIdSystem)?.value;
    const phone = matchedPhone ?? phonesOf(p).map((value) => canonicalPhone(value) ?? value)[0];
    return {
      id: p.id,
      fullName,
      firstName: p.name?.[0]?.given?.[0] ?? fullName.split(/\s+/)[0] ?? '',
      birthDate: p.birthDate !== undefined && isLocalDate(p.birthDate) ? p.birthDate : '',
      gender: p.gender === 'female' || p.gender === 'male' ? p.gender : 'unknown',
      ...(nationalId !== undefined ? { nationalId } : {}),
      ...(phone !== undefined ? { phone } : {}),
    };
  }
}

// ─────────────────────────────── mapping ───────────────────────────────

/** Every phone-like contact value on a patient record (FHIR `phone` and `sms` contact points), as stored. */
function phonesOf(p: FhirPatient): string[] {
  return (p.telecom ?? []).filter((t) => t.system === 'phone' || t.system === 'sms').flatMap((t) => (t.value !== undefined ? [t.value] : []));
}

function toEntry(item: DirectoryItem, score: number, dir: Directory): DirectoryEntry {
  if (item.kind === 'service') {
    const s = item.service;
    return { kind: 'service', score, service: { id: s.id, name: s.name, ...(s.durationMinutes !== undefined ? { durationMinutes: s.durationMinutes } : {}) } };
  }
  const p = item.practitioner;
  return {
    kind: 'practitioner',
    score,
    practitioner: { id: p.id, name: p.name, gender: p.gender, services: p.serviceIds.map((id) => ({ id, name: dir.services.get(id)?.name ?? '' })) },
  };
}

function toRecord(raw: FhirAppointment, dir: Directory): AppointmentRecord {
  if (raw.id === undefined) throw new ProviderError(MEDPLUM, 'bad_response', 'Appointment without id');
  const ref = (type: string) => raw.participant.map((p) => ({ id: idFromReference(p.actor?.reference, type), display: p.actor?.display })).find((p) => p.id !== undefined);
  const patient = ref('Patient');
  const practitioner = ref('Practitioner');
  const serviceId = referencedServiceIds(raw.serviceType)[0] ?? '';
  return {
    id: raw.id,
    patientId: patient?.id ?? '',
    serviceId,
    serviceName: dir.services.get(serviceId)?.name ?? raw.serviceType?.[0]?.text ?? '',
    practitionerId: practitioner?.id ?? '',
    practitionerName: (practitioner?.id !== undefined ? dir.practitioners.get(practitioner.id)?.name : undefined) ?? practitioner?.display ?? '',
    ...(practitioner?.id !== undefined && dir.practitioners.has(practitioner.id) ? { practitionerGender: dir.practitioners.get(practitioner.id)?.gender } : {}),
    start: parseInstant(raw.start, 'Appointment'),
    end: parseInstant(raw.end, 'Appointment'),
    status: toStatus(raw.status),
    ...(raw.meta?.versionId !== undefined ? { version: raw.meta.versionId } : {}),
    ...(raw.cancelationReason?.text !== undefined ? { cancellationReason: raw.cancelationReason.text } : {}),
  };
}

function toStatus(status: string): AppointmentStatus {
  return FHIR_STATUS.has(status) ? (status as AppointmentStatus) : 'other';
}

/** The Appointment inside an operation result: `$book`/`$reschedule` answer with a Bundle, `$cancel` with the Appointment. */
function appointmentFrom(json: unknown, operation: '$book' | '$reschedule' | '$cancel'): FhirAppointment {
  const record = asRecord(json);
  if (record?.['resourceType'] === 'Appointment') return parse(appointmentSchema, json, operation);
  if (record?.['resourceType'] === 'Bundle') {
    const [appointment] = resources(parse(bundleSchema, json, operation), appointmentSchema, 'Appointment');
    if (appointment) return appointment;
  }
  throw new ProviderError(MEDPLUM, 'bad_response', `${operation} response has no Appointment`);
}

/** The proposed Appointment from `$find`, with the patient, our idempotency identifier and any markers added. */
function withPatient(token: SlotToken, patientId: string, idempotencyKey: string, markers: AppointmentMarkers): Record<string, unknown> {
  const result = appointmentSchema.safeParse(token.appointment);
  if (!result.success) throw schedulingError('invalid_request', 'Slot token does not hold a proposed appointment');
  const parsed = result.data;
  const hasServiceReference = referencedServiceIds(parsed.serviceType).includes(token.service);
  const meta = asRecord(token.appointment['meta']);
  const existingTags: unknown[] = Array.isArray(meta?.['tag']) ? (meta['tag'] as unknown[]) : [];
  const tags = markers.tags ?? [];
  return {
    ...token.appointment,
    ...(tags.length > 0 ? { meta: { ...meta, tag: [...existingTags, ...tags] } } : {}),
    participant: [
      ...parsed.participant.filter((p) => idFromReference(p.actor?.reference, 'Patient') === undefined),
      { actor: { reference: `Patient/${patientId}` }, required: 'required', status: 'accepted' },
    ],
    identifier: [
      ...(parsed.identifier ?? []).filter((i) => i.system !== IDEMPOTENCY_KEY_SYSTEM),
      { system: IDEMPOTENCY_KEY_SYSTEM, value: idempotencyKey },
      ...(markers.identifiers ?? []),
    ],
    ...(hasServiceReference
      ? {}
      : { serviceType: [{ extension: [{ url: SERVICE_TYPE_REFERENCE_EXTENSION, valueReference: { reference: `HealthcareService/${token.service}` } }] }] }),
  };
}

/** Every schedule the proposed time occupies (from its contained Slots), plus the one it was found on. */
function destinationSchedules(token: SlotToken): string[] {
  const parsed = appointmentSchema.safeParse(token.appointment);
  const fromSlots = parsed.success ? (parsed.data.contained ?? []).filter((c) => c.resourceType === 'Slot').map((c) => idFromReference(c.schedule?.reference, 'Schedule')) : [];
  return [...new Set([token.schedule, ...fromSlots.filter((id): id is string => id !== undefined)])];
}

function decodeToken(slot: AvailableSlot): SlotToken {
  let token: Partial<SlotToken> | undefined;
  try {
    token = JSON.parse(Buffer.from(slot.token, 'base64url').toString('utf8')) as Partial<SlotToken>;
  } catch {
    token = undefined;
  }
  const valid =
    token?.v === 1 &&
    typeof token.schedule === 'string' &&
    asRecord(token.appointment) !== undefined &&
    token.practitioner === slot.practitionerId &&
    token.service === slot.serviceId &&
    token.start === slot.start.toISOString();
  if (!valid) throw schedulingError('invalid_request', 'Slot token does not match the slot');
  return token as SlotToken;
}

function resources<S extends z.ZodType>(bundle: { entry: { resource?: unknown }[] }, schema: S, type: string): z.infer<S>[] {
  return bundle.entry
    .map((e) => e.resource)
    .filter((r) => asRecord(r)?.['resourceType'] === type)
    .map((r) => parse(schema, r, type));
}

function parse<S extends z.ZodType>(schema: S, json: unknown, what: string): z.infer<S> {
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw new ProviderError(MEDPLUM, 'bad_response', `Unexpected ${what} response`);
  return parsed.data;
}

function parseInstant(value: string | undefined, what: string): Date {
  const date = value === undefined ? new Date(Number.NaN) : new Date(value);
  if (Number.isNaN(date.getTime())) throw new ProviderError(MEDPLUM, 'bad_response', `${what} without a valid start/end`);
  return date;
}

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index] as T);
    }
  });
  await Promise.all(workers);
  return results;
}

function checkLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_RESULTS_LIMIT) throw schedulingError('invalid_request', `limit must be 1..${MAX_RESULTS_LIMIT}`);
}

function checkKey(key: string): void {
  if (key.trim() === '') throw schedulingError('invalid_request', 'idempotencyKey is required');
}

function schedulingError(kind: SchedulingErrorKind, message: string): SchedulingError {
  return new SchedulingError(MEDPLUM, kind, message);
}
