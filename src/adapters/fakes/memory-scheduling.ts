import { abortReason, sleep } from '../../core/async.js';
import { ConfigError, ProviderError, SchedulingError, type SchedulingErrorKind } from '../../core/errors.js';
import { isNationalIdFormat } from '../../core/identifiers.js';
import { isCanonicalPhone, samePhone } from '../../core/phone.js';
import { rankByText } from '../../core/text-match.js';
import {
  type LocalDate,
  addDays,
  daysBetween,
  formatMinutes,
  instantToZoned,
  isLocalDate,
  minutesOfDay,
  weekdayOf,
  zonedToInstant,
} from '../../core/zoned-time.js';
import { type SchedulingDataset, dayNameToWeekday, resolveDatasetDates } from '../../contracts/scheduling-dataset.js';
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

/**
 * In-memory scheduling system built from a synthetic dataset. Used by tests and local development,
 * and as the second implementation that keeps the `SchedulingSystem` contract provider-neutral.
 *
 * Every check-and-write runs synchronously after the last `await`, so it is atomic: two concurrent
 * bookings of one slot cannot both succeed (same guarantee a real system gives transactionally).
 */

const SYSTEM = 'memory';
const ACTIVE: ReadonlySet<AppointmentStatus> = new Set(['booked', 'pending']);
const DAY_MS = 86_400_000;

export type SchedulingOperation =
  | 'searchDirectory'
  | 'findAvailability'
  | 'findPatients'
  | 'registerPatient'
  | 'getAppointment'
  | 'listAppointments'
  | 'book'
  | 'reschedule'
  | 'cancel';

export interface MemorySchedulingOptions {
  /** The only tenant this instance serves. */
  tenantId: string;
  dataset: SchedulingDataset;
  /** Clock (tests pin it). Default: real time. The anchor day for relative dataset dates is today in the clinic's time zone. */
  now?: () => Date;
  /** Simulated latency per call (abortable). */
  latencyMs?: number;
}

interface Service {
  id: string;
  name: string;
  searchText: string;
  durationMinutes: number;
}

interface WorkingHours {
  weekdays: ReadonlySet<number>;
  startMin: number;
  endMin: number;
}

interface Practitioner {
  id: string;
  name: string;
  gender: Gender;
  searchText: string;
  serviceIds: string[];
  hours: WorkingHours[];
}

interface Appointment {
  id: string;
  patientId: string;
  serviceId: string;
  practitionerId: string;
  start: Date;
  end: Date;
  status: AppointmentStatus;
  version: number;
  cancellationReason?: string;
}

interface Block {
  practitionerId: string;
  start: number;
  end: number;
}

interface Fault {
  error: Error;
  afterCommit: boolean;
}

type DirectoryItem = { kind: 'service'; service: Service } | { kind: 'practitioner'; practitioner: Practitioner };

export class MemorySchedulingSystem implements SchedulingSystem {
  readonly name = SYSTEM;
  readonly capabilities = { idempotencyKeys: true } as const;
  /** Clinic time zone from the dataset. */
  readonly timeZone: string;
  /** Clinic-local day that relative dataset dates were resolved against. */
  readonly anchorDate: LocalDate;

  private readonly tenantId: string;
  private readonly now: () => Date;
  private readonly latencyMs: number;
  private readonly services = new Map<string, Service>();
  private readonly practitioners = new Map<string, Practitioner>();
  private readonly patients = new Map<string, PatientRecord>();
  private readonly appointments = new Map<string, Appointment>();
  private readonly blocks: Block[] = [];
  private readonly idempotency = new Map<string, { fingerprint: string; resultId: string }>();
  private readonly faults = new Map<SchedulingOperation, Fault[]>();
  private sequence = 0;

  constructor(options: MemorySchedulingOptions) {
    const { dataset } = options;
    this.tenantId = options.tenantId;
    this.now = options.now ?? (() => new Date());
    this.latencyMs = options.latencyMs ?? 0;
    this.timeZone = dataset.clinic.timezone;
    this.anchorDate = instantToZoned(this.now(), this.timeZone).date;

    const serviceIds = new Map<string, string>();
    for (const s of dataset.services) {
      const id = this.nextId('svc');
      serviceIds.set(s.key, id);
      this.services.set(id, { id, name: s.name, searchText: [s.name, ...s.aliases].join(' '), durationMinutes: s.durationMinutes });
    }
    const practitionerIds = new Map<string, string>();
    for (const p of dataset.practitioners) {
      const id = this.nextId('prac');
      practitionerIds.set(p.key, id);
      const ids = p.serviceKeys.map((k) => serviceIds.get(k) ?? '');
      const serviceText = ids.map((sid) => this.services.get(sid)?.searchText ?? '');
      this.practitioners.set(id, {
        id,
        name: p.name,
        gender: p.gender,
        searchText: [p.name, ...p.aliases, ...serviceText].join(' '),
        serviceIds: ids,
        hours: p.availability.map((a) => ({
          weekdays: new Set(a.days.map(dayNameToWeekday)),
          startMin: minutesOfDay(a.start),
          endMin: minutesOfDay(a.end),
        })),
      });
    }
    const patientIds = new Map<string, string>();
    for (const p of dataset.patients) {
      const id = this.nextId('pat');
      patientIds.set(p.key, id);
      this.patients.set(id, {
        id,
        fullName: p.fullName,
        firstName: p.firstName ?? firstToken(p.fullName),
        birthDate: p.birthDate,
        gender: p.gender,
        nationalId: p.nationalId,
        phone: p.phone,
      });
    }

    const resolved = resolveDatasetDates(dataset, this.anchorDate);
    for (const b of resolved.blocks) {
      this.blocks.push({
        practitionerId: practitionerIds.get(b.practitionerKey) ?? '',
        start: zonedToInstant(b.startDate, '00:00', this.timeZone).getTime(),
        end: zonedToInstant(addDays(b.endDate, 1), '00:00', this.timeZone).getTime(),
      });
    }
    for (const a of resolved.appointments) {
      const practitioner = this.practitioners.get(practitionerIds.get(a.practitionerKey) ?? '');
      const service = this.services.get(serviceIds.get(a.serviceKey) ?? '');
      if (!practitioner || !service) throw new ConfigError(`Dataset appointment '${a.key}' references unknown entities`);
      const start = zonedToInstant(a.date, a.time, this.timeZone);
      const end = new Date(start.getTime() + service.durationMinutes * 60_000);
      const problem = this.slotProblem(practitioner, service, start, end);
      if (problem) throw new ConfigError(`Dataset appointment '${a.key}' cannot be placed: ${problem}`);
      const id = this.nextId('apt');
      this.appointments.set(id, { id, patientId: patientIds.get(a.patientKey) ?? '', serviceId: service.id, practitionerId: practitioner.id, start, end, status: 'booked', version: 1 });
    }
  }

  /**
   * Fault injection for tests: the next call to `operation` fails with `error` — before anything
   * changes, or (`afterCommit`) after a write was applied, like a timeout whose outcome is unknown.
   */
  failNext(operation: SchedulingOperation, error: Error, options?: { afterCommit?: boolean }): void {
    const queue = this.faults.get(operation) ?? [];
    queue.push({ error, afterCommit: options?.afterCommit === true });
    this.faults.set(operation, queue);
  }

  // ─────────────────────────────── directory ───────────────────────────────

  async searchDirectory(ctx: SchedulingContext, query: DirectorySearchQuery): Promise<DirectorySearchResult> {
    await this.enter(ctx, 'searchDirectory');
    checkLimit(query.limit);
    if (query.serviceId !== undefined) this.service(query.serviceId);
    const items: DirectoryItem[] = [];
    if (query.kind !== 'practitioner') {
      for (const service of this.services.values()) {
        if (query.serviceId === undefined || service.id === query.serviceId) items.push({ kind: 'service', service });
      }
    }
    if (query.kind !== 'service') {
      for (const practitioner of this.practitioners.values()) {
        if (query.serviceId === undefined || practitioner.serviceIds.includes(query.serviceId)) items.push({ kind: 'practitioner', practitioner });
      }
    }
    const text = query.text?.trim() ?? '';
    const ranked =
      text === ''
        ? items.map((item) => ({ item, score: 1 }))
        : rankByText(text, items, (item) => [item.kind === 'service' ? item.service.searchText : item.practitioner.searchText]);
    return {
      entries: ranked.slice(0, query.limit).map(({ item, score }) => this.toEntry(item, score)),
      hasMore: ranked.length > query.limit,
    };
  }

  // ─────────────────────────────── availability ───────────────────────────────

  async findAvailability(ctx: SchedulingContext, query: AvailabilityQuery): Promise<AvailabilityResult> {
    await this.enter(ctx, 'findAvailability');
    checkLimit(query.limit);
    const from = query.from.getTime();
    const to = query.to.getTime();
    if (Number.isNaN(from) || Number.isNaN(to) || from >= to) throw schedulingError('invalid_request', 'Availability window must have from < to');
    if (to - from > MAX_AVAILABILITY_WINDOW_DAYS * DAY_MS) throw schedulingError('invalid_request', `Availability window exceeds ${MAX_AVAILABILITY_WINDOW_DAYS} days`);
    const service = this.service(query.serviceId);
    if (query.ignoreAppointmentId !== undefined) this.appointment(query.ignoreAppointmentId);
    let practitioners: Practitioner[];
    if (query.practitionerIds !== undefined) {
      if (query.practitionerIds.length === 0) throw schedulingError('invalid_request', 'practitionerIds must not be empty when given');
      practitioners = query.practitionerIds.map((id) => this.practitioner(id));
      if (practitioners.some((p) => !p.serviceIds.includes(service.id))) throw schedulingError('invalid_request', 'A requested practitioner does not offer this service');
    } else {
      practitioners = [...this.practitioners.values()].filter((p) => p.serviceIds.includes(service.id));
    }

    const earliest = Math.max(from, this.now().getTime() + 1);
    const lastDate = instantToZoned(new Date(to - 1), this.timeZone).date;
    const slots: AvailableSlot[] = [];
    for (let date = instantToZoned(new Date(earliest), this.timeZone).date; daysBetween(date, lastDate) >= 0; date = addDays(date, 1)) {
      for (const practitioner of practitioners) {
        for (const minutes of slotStarts(practitioner, service, date)) {
          const start = zonedToInstant(date, formatMinutes(minutes), this.timeZone);
          const end = new Date(start.getTime() + service.durationMinutes * 60_000);
          if (start.getTime() < earliest || start.getTime() >= to) continue;
          if (this.isBusy(practitioner.id, start.getTime(), end.getTime(), query.ignoreAppointmentId)) continue;
          slots.push(this.toSlot(practitioner, service, start, end));
        }
      }
    }
    slots.sort((a, b) => a.start.getTime() - b.start.getTime() || a.practitionerName.localeCompare(b.practitionerName));
    return { slots: slots.slice(0, query.limit), hasMore: slots.length > query.limit };
  }

  // ─────────────────────────────── patients ───────────────────────────────

  async findPatients(ctx: SchedulingContext, lookup: PatientLookup): Promise<readonly PatientRecord[]> {
    await this.enter(ctx, 'findPatients');
    if (lookup.nationalId === undefined && lookup.phone === undefined) throw schedulingError('invalid_request', 'Patient lookup needs a national ID or a phone number');
    if (lookup.nationalId !== undefined && !isNationalIdFormat(lookup.nationalId)) throw schedulingError('invalid_request', 'National ID is not in canonical form');
    if (lookup.phone !== undefined && !isCanonicalPhone(lookup.phone)) throw schedulingError('invalid_request', 'Phone is not in canonical form');
    return [...this.patients.values()]
      .filter((p) => (lookup.nationalId === undefined || p.nationalId === lookup.nationalId) && (lookup.phone === undefined || samePhone(p.phone, lookup.phone)))
      .map((p) => ({ ...p }));
  }

  async registerPatient(ctx: SchedulingContext, request: RegisterPatientRequest): Promise<PatientRecord> {
    const fault = await this.enter(ctx, 'registerPatient');
    const p = request.patient;
    checkKey(request.idempotencyKey);
    if (p.fullName.trim() === '') throw schedulingError('invalid_request', 'Full name is required');
    if (!isNationalIdFormat(p.nationalId)) throw schedulingError('invalid_request', 'National ID is not in canonical form');
    if (!isCanonicalPhone(p.phone)) throw schedulingError('invalid_request', 'Phone is not in canonical form');
    if (!isLocalDate(p.birthDate) || p.birthDate > instantToZoned(this.now(), this.timeZone).date) throw schedulingError('invalid_request', 'Birth date is invalid');

    const replayed = this.replay(request.idempotencyKey, `register|${p.nationalId}`);
    let patient = replayed === undefined ? undefined : this.patients.get(replayed);
    if (!patient) {
      if ([...this.patients.values()].some((x) => x.nationalId === p.nationalId)) throw schedulingError('already_exists', 'A patient with this national ID is already registered');
      const id = this.nextId('pat');
      patient = { id, fullName: p.fullName.trim(), firstName: firstToken(p.fullName), birthDate: p.birthDate, gender: p.gender, nationalId: p.nationalId, phone: p.phone };
      this.patients.set(id, patient);
      this.remember(request.idempotencyKey, `register|${p.nationalId}`, id);
    }
    if (fault) throw fault.error;
    return { ...patient };
  }

  // ─────────────────────────────── appointments ───────────────────────────────

  async getAppointment(ctx: SchedulingContext, appointmentId: string): Promise<AppointmentRecord> {
    await this.enter(ctx, 'getAppointment');
    return this.toRecord(this.appointment(appointmentId));
  }

  async listAppointments(ctx: SchedulingContext, query: AppointmentListQuery): Promise<readonly AppointmentRecord[]> {
    await this.enter(ctx, 'listAppointments');
    this.patient(query.patientId);
    const from = (query.from ?? this.now()).getTime();
    const statuses = new Set(query.statuses ?? ACTIVE);
    return [...this.appointments.values()]
      .filter((a) => a.patientId === query.patientId && statuses.has(a.status) && a.start.getTime() >= from)
      .sort((a, b) => a.start.getTime() - b.start.getTime())
      .map((a) => this.toRecord(a));
  }

  async book(ctx: SchedulingContext, request: BookingRequest): Promise<AppointmentRecord> {
    const fault = await this.enter(ctx, 'book');
    checkKey(request.idempotencyKey);
    const fingerprint = `book|${request.patientId}|${request.slot.token}`;
    const replayed = this.replay(request.idempotencyKey, fingerprint);
    let appointment = replayed === undefined ? undefined : this.appointments.get(replayed);
    if (!appointment) {
      this.patient(request.patientId);
      const { practitioner, service, start, end } = this.resolveSlot(request.slot);
      const problem = this.slotProblem(practitioner, service, start, end);
      if (problem) throw schedulingError('slot_unavailable', `Requested time is not available (${problem})`);
      const id = this.nextId('apt');
      appointment = { id, patientId: request.patientId, serviceId: service.id, practitionerId: practitioner.id, start, end, status: 'booked', version: 1 };
      this.appointments.set(id, appointment);
      this.remember(request.idempotencyKey, fingerprint, id);
    }
    if (fault) throw fault.error;
    return this.toRecord(appointment);
  }

  async reschedule(ctx: SchedulingContext, request: RescheduleRequest): Promise<AppointmentRecord> {
    const fault = await this.enter(ctx, 'reschedule');
    checkKey(request.idempotencyKey);
    const appointment = this.appointment(request.appointmentId);
    const fingerprint = `reschedule|${appointment.id}|${request.newSlot.token}`;
    if (this.replay(request.idempotencyKey, fingerprint) === undefined) {
      if (!ACTIVE.has(appointment.status)) throw schedulingError('invalid_state', `Appointment cannot be rescheduled in '${appointment.status}' status`);
      const { practitioner, service, start, end } = this.resolveSlot(request.newSlot);
      if (service.id !== appointment.serviceId) throw schedulingError('invalid_request', 'Rescheduling cannot change the service; cancel and book instead');
      const problem = this.slotProblem(practitioner, service, start, end, appointment.id);
      if (problem) throw schedulingError('slot_unavailable', `Requested time is not available (${problem})`);
      appointment.practitionerId = practitioner.id;
      appointment.start = start;
      appointment.end = end;
      appointment.version += 1;
      this.remember(request.idempotencyKey, fingerprint, appointment.id);
    }
    if (fault) throw fault.error;
    return this.toRecord(appointment);
  }

  async cancel(ctx: SchedulingContext, request: CancelRequest): Promise<AppointmentRecord> {
    const fault = await this.enter(ctx, 'cancel');
    checkKey(request.idempotencyKey);
    const appointment = this.appointment(request.appointmentId);
    const fingerprint = `cancel|${appointment.id}`;
    if (this.replay(request.idempotencyKey, fingerprint) === undefined) {
      if (!ACTIVE.has(appointment.status)) throw schedulingError('invalid_state', `Appointment cannot be cancelled in '${appointment.status}' status`);
      appointment.status = 'cancelled';
      if (request.reason !== undefined && request.reason.trim() !== '') appointment.cancellationReason = request.reason.trim();
      appointment.version += 1;
      this.remember(request.idempotencyKey, fingerprint, appointment.id);
    }
    if (fault) throw fault.error;
    return this.toRecord(appointment);
  }

  // ─────────────────────────────── internals ───────────────────────────────

  /** Tenant guard, abort, simulated latency, injected faults. Returns an after-commit fault to throw later. */
  private async enter(ctx: SchedulingContext, operation: SchedulingOperation): Promise<Fault | undefined> {
    if (ctx.tenant.tenantId !== this.tenantId) {
      throw new ProviderError(SYSTEM, 'auth', 'Scheduling system is not configured for this tenant', { retryable: false });
    }
    if (ctx.signal.aborted) throw abortReason(ctx.signal);
    if (this.latencyMs > 0) await sleep(this.latencyMs, ctx.signal);
    const fault = this.faults.get(operation)?.shift();
    if (fault && !fault.afterCommit) throw fault.error;
    return fault;
  }

  /** Returns the earlier result ID for a replayed key; throws if the key was used for a different request. */
  private replay(key: string, fingerprint: string): string | undefined {
    const seen = this.idempotency.get(key);
    if (!seen) return undefined;
    if (seen.fingerprint !== fingerprint) throw schedulingError('invalid_request', 'Idempotency key was already used for a different request');
    return seen.resultId;
  }

  private remember(key: string, fingerprint: string, resultId: string): void {
    this.idempotency.set(key, { fingerprint, resultId });
  }

  private resolveSlot(slot: AvailableSlot): { practitioner: Practitioner; service: Service; start: Date; end: Date } {
    const decoded = decodeToken(slot.token);
    if (!decoded || decoded.p !== slot.practitionerId || decoded.s !== slot.serviceId || decoded.t !== slot.start.getTime()) {
      throw schedulingError('invalid_request', 'Slot token does not match the slot');
    }
    const practitioner = this.practitioner(decoded.p);
    const service = this.service(decoded.s);
    const start = new Date(decoded.t);
    return { practitioner, service, start, end: new Date(decoded.t + service.durationMinutes * 60_000) };
  }

  /** Why this exact time cannot be booked now, or undefined if it can. */
  private slotProblem(practitioner: Practitioner, service: Service, start: Date, end: Date, ignoreAppointmentId?: string): string | undefined {
    if (!practitioner.serviceIds.includes(service.id)) return 'practitioner does not offer this service';
    if (start.getTime() <= this.now().getTime()) return 'time is in the past';
    const local = instantToZoned(start, this.timeZone);
    if (start.getTime() % 60_000 !== 0 || !slotStarts(practitioner, service, local.date).includes(local.minutes)) return 'outside working hours or slot grid';
    if (this.isBusy(practitioner.id, start.getTime(), end.getTime(), ignoreAppointmentId)) return 'time is already taken or blocked';
    return undefined;
  }

  private isBusy(practitionerId: string, start: number, end: number, ignoreAppointmentId?: string): boolean {
    if (this.blocks.some((b) => b.practitionerId === practitionerId && b.start < end && start < b.end)) return true;
    for (const a of this.appointments.values()) {
      if (a.id === ignoreAppointmentId || a.practitionerId !== practitionerId || !ACTIVE.has(a.status)) continue;
      if (a.start.getTime() < end && start < a.end.getTime()) return true;
    }
    return false;
  }

  private service(id: string): Service {
    const service = this.services.get(id);
    if (!service) throw schedulingError('not_found', 'Service not found');
    return service;
  }

  private practitioner(id: string): Practitioner {
    const practitioner = this.practitioners.get(id);
    if (!practitioner) throw schedulingError('not_found', 'Practitioner not found');
    return practitioner;
  }

  private patient(id: string): PatientRecord {
    const patient = this.patients.get(id);
    if (!patient) throw schedulingError('not_found', 'Patient not found');
    return patient;
  }

  private appointment(id: string): Appointment {
    const appointment = this.appointments.get(id);
    if (!appointment) throw schedulingError('not_found', 'Appointment not found');
    return appointment;
  }

  private toEntry(item: DirectoryItem, score: number): DirectoryEntry {
    if (item.kind === 'service') {
      const s = item.service;
      return { kind: 'service', score, service: { id: s.id, name: s.name, durationMinutes: s.durationMinutes } };
    }
    const p = item.practitioner;
    return {
      kind: 'practitioner',
      score,
      practitioner: { id: p.id, name: p.name, gender: p.gender, services: p.serviceIds.map((id) => ({ id, name: this.services.get(id)?.name ?? '' })) },
    };
  }

  private toSlot(practitioner: Practitioner, service: Service, start: Date, end: Date): AvailableSlot {
    return {
      start,
      end,
      serviceId: service.id,
      serviceName: service.name,
      practitionerId: practitioner.id,
      practitionerName: practitioner.name,
      practitionerGender: practitioner.gender,
      token: encodeToken({ p: practitioner.id, s: service.id, t: start.getTime() }),
    };
  }

  private toRecord(a: Appointment): AppointmentRecord {
    return {
      id: a.id,
      patientId: a.patientId,
      serviceId: a.serviceId,
      serviceName: this.services.get(a.serviceId)?.name ?? '',
      practitionerId: a.practitionerId,
      practitionerName: this.practitioners.get(a.practitionerId)?.name ?? '',
      ...(this.practitioners.get(a.practitionerId) ? { practitionerGender: this.practitioners.get(a.practitionerId)?.gender } : {}),
      start: new Date(a.start),
      end: new Date(a.end),
      status: a.status,
      version: String(a.version),
      ...(a.cancellationReason !== undefined ? { cancellationReason: a.cancellationReason } : {}),
    };
  }

  private nextId(kind: string): string {
    this.sequence += 1;
    return `mem-${kind}-${this.sequence}`;
  }
}

/** Slot start minutes (local) for a practitioner/service on a clinic-local date. */
function slotStarts(practitioner: Practitioner, service: Service, date: LocalDate): number[] {
  const weekday = weekdayOf(date);
  const starts = new Set<number>();
  for (const hours of practitioner.hours) {
    if (!hours.weekdays.has(weekday)) continue;
    for (let m = hours.startMin; m + service.durationMinutes <= hours.endMin; m += service.durationMinutes) starts.add(m);
  }
  return [...starts].sort((a, b) => a - b);
}

interface SlotToken {
  p: string;
  s: string;
  t: number;
}

function encodeToken(token: SlotToken): string {
  return Buffer.from(JSON.stringify(token)).toString('base64url');
}

function decodeToken(token: string): SlotToken | undefined {
  try {
    const value: unknown = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
    if (typeof value !== 'object' || value === null) return undefined;
    const { p, s, t } = value as Record<string, unknown>;
    return typeof p === 'string' && typeof s === 'string' && typeof t === 'number' ? { p, s, t } : undefined;
  } catch {
    return undefined;
  }
}

function checkLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_RESULTS_LIMIT) throw schedulingError('invalid_request', `limit must be 1..${MAX_RESULTS_LIMIT}`);
}

function checkKey(key: string): void {
  if (key.trim() === '') throw schedulingError('invalid_request', 'idempotencyKey is required');
}

function firstToken(fullName: string): string {
  return fullName.trim().split(/\s+/)[0] ?? fullName.trim();
}

function schedulingError(kind: SchedulingErrorKind, message: string): SchedulingError {
  return new SchedulingError(SYSTEM, kind, message);
}
