import type { TenantContext } from '../core/tenant.js';
import type { LocalDate } from '../core/zoned-time.js';

/**
 * Mujeeb's contract with a scheduling system (HIS/EHR/scheduling API). Each system gets its own
 * adapter; agent tools and business rules depend only on this file. Nothing here names a vendor
 * or a vendor data model.
 *
 * Error semantics for every method:
 * - business outcomes ("slot taken", "not found", …) → `SchedulingError` (core/errors);
 * - transport/system failures (auth, timeout, unavailable, bad response) → `ProviderError`;
 * - `ctx.signal` aborted → rejects with the abort reason.
 *
 * IDs are opaque strings owned by the scheduling system. They stay on the server and are never
 * shown to the language model.
 */

/** Longest availability window callers may request. Adapters reject longer windows with `invalid_request`. */
export const MAX_AVAILABILITY_WINDOW_DAYS = 14;

/** Upper bound for `limit` in searches. */
export const MAX_RESULTS_LIMIT = 50;

export interface SchedulingContext {
  /** Trusted tenant from the composition root. An adapter serves exactly one tenant and rejects others. */
  readonly tenant: TenantContext;
  readonly signal: AbortSignal;
  /** Session/turn correlation for adapter logs. */
  readonly correlationId?: string;
}

export interface SchedulingCapabilities {
  /** True when repeating a write with the same `idempotencyKey` returns the first result instead of applying it again. */
  readonly idempotencyKeys: boolean;
}

export type Gender = 'female' | 'male' | 'unknown';

// ─────────────────────────────── directory ───────────────────────────────

export interface ServiceInfo {
  readonly id: string;
  /** Display name in the tenant's language. */
  readonly name: string;
  readonly durationMinutes?: number;
}

export interface PractitionerInfo {
  readonly id: string;
  /** Display name without titles (callers add "الدكتور/الدكتورة" from `gender`). */
  readonly name: string;
  readonly gender: Gender;
  readonly services: readonly { readonly id: string; readonly name: string }[];
}

export type DirectoryEntry =
  | { readonly kind: 'service'; readonly score: number; readonly service: ServiceInfo }
  | { readonly kind: 'practitioner'; readonly score: number; readonly practitioner: PractitionerInfo };

export interface DirectorySearchQuery {
  /** Free text (Arabic or English). Empty/absent lists everything of `kind`. */
  readonly text?: string;
  readonly kind: 'service' | 'practitioner' | 'any';
  /** Only practitioners offering this service. */
  readonly serviceId?: string;
  readonly limit: number;
}

export interface DirectorySearchResult {
  /** Best match first. `score` is in (0, 1]; 1 when no text was given. */
  readonly entries: readonly DirectoryEntry[];
  readonly hasMore: boolean;
}

// ─────────────────────────────── availability ───────────────────────────────

export interface AvailabilityQuery {
  readonly serviceId: string;
  /** Restrict to these practitioners (each must offer the service). Absent = anyone offering it. */
  readonly practitionerIds?: readonly string[];
  /** Slots starting in [from, to). At most MAX_AVAILABILITY_WINDOW_DAYS long. Past slots are never returned. */
  readonly from: Date;
  readonly to: Date;
  readonly limit: number;
  /** Rescheduling: compute availability as if this appointment did not exist. */
  readonly ignoreAppointmentId?: string;
}

export interface AvailableSlot {
  readonly start: Date;
  readonly end: Date;
  readonly serviceId: string;
  readonly serviceName: string;
  readonly practitionerId: string;
  readonly practitionerName: string;
  /** For spoken titles (الدّكتور / الدّكتورة), when the system knows it. */
  readonly practitionerGender?: Gender;
  /**
   * Opaque adapter data needed to commit exactly this slot. Server-side only. A slot is a
   * proposal, not a hold: availability is validated again, atomically, when it is booked.
   */
  readonly token: string;
}

export interface AvailabilityResult {
  /** Earliest first. */
  readonly slots: readonly AvailableSlot[];
  readonly hasMore: boolean;
}

// ─────────────────────────────── patients ───────────────────────────────

/**
 * At least one field. Values are canonical: phone as `core/phone` canonicalPhone (E.164, +9665XXXXXXXX for
 * Saudi mobiles), ASCII-digit national ID. All given fields must match. Systems store phone numbers in many
 * spellings: an adapter searches its system with what it supports (e.g. `phoneSearchForms`), without scanning
 * all patients, and keeps only records with a phone that `samePhone` matches. Everyone sharing the number is
 * returned (family phones); deciding between them is the caller's job.
 */
export interface PatientLookup {
  readonly nationalId?: string;
  readonly phone?: string;
}

export interface PatientRecord {
  readonly id: string;
  readonly fullName: string;
  readonly firstName: string;
  readonly birthDate: LocalDate;
  readonly gender: Gender;
  readonly nationalId?: string;
  readonly phone?: string;
}

export interface NewPatient {
  readonly fullName: string;
  readonly nationalId: string;
  readonly phone: string;
  readonly birthDate: LocalDate;
  readonly gender: Gender;
}

// ─────────────────────────────── appointments ───────────────────────────────

export type AppointmentStatus = 'pending' | 'booked' | 'cancelled' | 'fulfilled' | 'noshow' | 'other';

export interface AppointmentRecord {
  readonly id: string;
  readonly patientId: string;
  readonly serviceId: string;
  readonly serviceName: string;
  readonly practitionerId: string;
  readonly practitionerName: string;
  readonly practitionerGender?: Gender;
  readonly start: Date;
  readonly end: Date;
  readonly status: AppointmentStatus;
  /** Changes on every modification. Extra guard for changes to existing appointments — never a substitute for execution-time validation. */
  readonly version?: string;
  readonly cancellationReason?: string;
}

export interface AppointmentListQuery {
  readonly patientId: string;
  /** Default: now. */
  readonly from?: Date;
  /** Default: `['booked', 'pending']`. */
  readonly statuses?: readonly AppointmentStatus[];
}

export interface RegisterPatientRequest {
  readonly patient: NewPatient;
  readonly idempotencyKey: string;
}

export interface BookingRequest {
  readonly patientId: string;
  readonly slot: AvailableSlot;
  readonly idempotencyKey: string;
}

export interface RescheduleRequest {
  readonly appointmentId: string;
  /** Must be for the same service. Found with `ignoreAppointmentId` set to this appointment. */
  readonly newSlot: AvailableSlot;
  readonly idempotencyKey: string;
}

export interface CancelRequest {
  readonly appointmentId: string;
  readonly reason?: string;
  readonly idempotencyKey: string;
}

export interface SchedulingSystem {
  /** Short, stable name for logs/errors (e.g. `memory`). */
  readonly name: string;
  readonly capabilities: SchedulingCapabilities;

  searchDirectory(ctx: SchedulingContext, query: DirectorySearchQuery): Promise<DirectorySearchResult>;
  findAvailability(ctx: SchedulingContext, query: AvailabilityQuery): Promise<AvailabilityResult>;

  /** Candidates only — verification (e.g. date of birth) is Mujeeb's job, not the adapter's. */
  findPatients(ctx: SchedulingContext, lookup: PatientLookup): Promise<readonly PatientRecord[]>;
  /** `already_exists` when the national ID is registered (unless this is a replay of the same key). */
  registerPatient(ctx: SchedulingContext, request: RegisterPatientRequest): Promise<PatientRecord>;

  getAppointment(ctx: SchedulingContext, appointmentId: string): Promise<AppointmentRecord>;
  /** Earliest first. `not_found` for an unknown patient. */
  listAppointments(ctx: SchedulingContext, query: AppointmentListQuery): Promise<readonly AppointmentRecord[]>;

  /** Validates availability atomically at execution time: `slot_unavailable` if the time is no longer free. */
  book(ctx: SchedulingContext, request: BookingRequest): Promise<AppointmentRecord>;
  /** Same appointment ID, new time. `invalid_state` unless booked/pending; `slot_unavailable` if the new time is taken. */
  reschedule(ctx: SchedulingContext, request: RescheduleRequest): Promise<AppointmentRecord>;
  /** `invalid_state` unless booked/pending. Frees the time. */
  cancel(ctx: SchedulingContext, request: CancelRequest): Promise<AppointmentRecord>;
}
