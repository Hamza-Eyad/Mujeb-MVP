import { withDeadline } from '../../core/async.js';
import { ProviderError, SchedulingError, errorSummary, isAbortLike } from '../../core/errors.js';
import type { Logger } from '../../core/logger.js';
import type { TenantContext } from '../../core/tenant.js';
import { type LocalDate, addDays, daysBetween, formatMinutes, instantToZoned, isLocalDate, zonedToInstant } from '../../core/zoned-time.js';
import {
  APPOINTMENT_TOOLS,
  APPOINTMENT_TOOL_NAMES,
  type AppointmentToolName,
  type ConfirmPendingActionInput,
  type FindPatientInput,
  type ListPatientAppointmentsInput,
  type ProposeBookingInput,
  type ProposeCancellationInput,
  type ProposeRegistrationInput,
  type ProposeRescheduleInput,
  type SearchAvailableSlotsInput,
  type SearchClinicDirectoryInput,
  isAppointmentToolName,
  parseToolArguments,
  toolParametersJsonSchema,
} from '../../contracts/appointment-tools.js';
import {
  type AppointmentRecord,
  type AppointmentStatus,
  type AvailableSlot,
  MAX_AVAILABILITY_WINDOW_DAYS,
  type PatientRecord,
  type SchedulingContext,
  type SchedulingSystem,
} from '../../ports/scheduling.js';
import { phoneDigitsHeard } from '../../core/phone.js';
import { normalizeBirthDate, normalizeNationalId, normalizePhone, toAsciiDigits } from './normalize.js';
import { DEV_VERIFICATION_POLICY, DevIdentifierDobVerification, type VerificationPolicyName } from './patient-verification.js';
import { spokenCalendarDate, spokenDate, spokenDateTime, spokenDigits, spokenDoctor, spokenTime } from './spoken-arabic.js';
import { type ActionTarget, PendingActions, actionPatientKey } from './pending-actions.js';
import { type RefValues, SessionRefs } from './session-refs.js';
import { type ReconcileResult, WriteLedger } from './write-ledger.js';

/**
 * The appointment tools for one session (plans/2026-10-12 §3.2–3.4). Mujeeb-owned business rules live
 * here; the scheduling system is reached only through the `SchedulingSystem` port.
 *
 * `execute` never throws for tool problems — every outcome becomes a compact JSON result for the model.
 * It rejects only when the caller's turn was cancelled during a read. Confirmed writes are detached
 * from the turn: once the caller has said yes, an interruption does not abandon the write.
 */

export interface ToolTurnContext {
  /** 1, 2, … for the caller's committed turns in this session. Supplied by the session, never by the model. */
  readonly userTurn: number;
  /** The caller's own words in this turn (STT transcript) — the only input confirmations trust. */
  readonly callerUtterance: string;
  readonly turnId: string;
  /** Cancels reads when the turn is abandoned. Confirmed writes ignore it. */
  readonly signal: AbortSignal;
}

export interface ToolCallResult {
  /** Compact JSON for the model. Never contains scheduling-system IDs, national IDs of existing patients, or dates of birth. */
  readonly output: Record<string, unknown>;
  /** `status` of the output, for metrics. */
  readonly outcome: string;
  /**
   * Authoritative words for the caller (a read-back to confirm, or the result of a write), built from the
   * stored action/record. The agent speaks them verbatim itself and ends the turn: the model never words them.
   */
  readonly speech?: string;
}

/** Carries `speech` beside a tool output without serializing it to the model (JSON ignores symbol keys). */
const SPEAK: unique symbol = Symbol('speak');
type ToolOutput = Record<string, unknown> & { [SPEAK]?: string };

export interface AppointmentToolDefinition {
  readonly name: AppointmentToolName;
  readonly description: string;
  /** Strict JSON Schema of the arguments. */
  readonly parameters: Record<string, unknown>;
}

export interface AppointmentToolsOptions {
  scheduling: SchedulingSystem;
  tenant: TenantContext;
  sessionId: string;
  /** Clinic time zone, e.g. `Asia/Riyadh`. */
  timeZone: string;
  log: Logger;
  /** Development-only policy (DECISIONS A17); named explicitly so it cannot be mistaken for production auth. */
  verificationPolicy: VerificationPolicyName;
  now?: () => Date;
  /** Tools this tenant allows. Default: all. */
  allowedTools?: readonly AppointmentToolName[];
  maxFailedVerifications?: number;
  pendingActionTtlMs?: number;
  maxReconfirmations?: number;
  readTimeoutMs?: number;
  writeTimeoutMs?: number;
  /** Results per search shown to the model (voice: keep it small). */
  maxResults?: number;
  /** Days searched when the model gives no end date. */
  defaultSearchDays?: number;
}

const WEEKDAYS = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'] as const;
const PART_OF_DAY: Record<'morning' | 'afternoon' | 'evening', [number, number]> = { morning: [0, 720], afternoon: [720, 1020], evening: [1020, 1440] };
const ACTIVE: ReadonlySet<AppointmentStatus> = new Set(['booked', 'pending']);
const LIST_LIMIT = 10;

/** An early, expected refusal (bad ref, invalid input, …) turned into a tool result. */
class ToolRejection extends Error {
  constructor(
    readonly status: string,
    readonly hint: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(status);
  }
}

type WriteResult = PatientRecord | AppointmentRecord;

export class AppointmentTools {
  readonly verificationPolicy: VerificationPolicyName;
  private readonly o: Required<Omit<AppointmentToolsOptions, 'allowedTools' | 'log' | 'now'>>;
  private readonly log: Logger;
  private readonly now: () => Date;
  private readonly allowed: ReadonlySet<AppointmentToolName>;
  private readonly refs = new SessionRefs();
  private readonly verification: DevIdentifierDobVerification;
  private readonly pending: PendingActions;
  private readonly ledger: WriteLedger;

  constructor(options: AppointmentToolsOptions) {
    if (options.verificationPolicy !== DEV_VERIFICATION_POLICY) throw new Error(`Unsupported patient verification policy: ${String(options.verificationPolicy)}`);
    this.verificationPolicy = options.verificationPolicy;
    this.o = {
      scheduling: options.scheduling,
      tenant: options.tenant,
      sessionId: options.sessionId,
      timeZone: options.timeZone,
      verificationPolicy: options.verificationPolicy,
      maxFailedVerifications: options.maxFailedVerifications ?? 3,
      pendingActionTtlMs: options.pendingActionTtlMs ?? 120_000,
      maxReconfirmations: options.maxReconfirmations ?? 2,
      readTimeoutMs: options.readTimeoutMs ?? 4_000,
      writeTimeoutMs: options.writeTimeoutMs ?? 8_000,
      maxResults: options.maxResults ?? 5,
      defaultSearchDays: options.defaultSearchDays ?? 7,
    };
    this.log = options.log.child({ component: 'appointment_tools', session_id: options.sessionId, tenant_id: options.tenant.tenantId });
    this.now = options.now ?? (() => new Date());
    this.allowed = new Set(options.allowedTools ?? APPOINTMENT_TOOL_NAMES);
    this.verification = new DevIdentifierDobVerification({ maxFailures: this.o.maxFailedVerifications });
    const nowMs = (): number => this.now().getTime();
    this.pending = new PendingActions({
      tenantId: options.tenant.tenantId,
      sessionId: options.sessionId,
      ttlMs: this.o.pendingActionTtlMs,
      maxReconfirmations: this.o.maxReconfirmations,
      now: nowMs,
    });
    this.ledger = new WriteLedger({
      system: options.scheduling.name,
      writeTimeoutMs: this.o.writeTimeoutMs,
      readTimeoutMs: this.o.readTimeoutMs,
      maxReconcileAttempts: 2,
      log: this.log,
      now: nowMs,
    });
  }

  definitions(): AppointmentToolDefinition[] {
    return APPOINTMENT_TOOL_NAMES.filter((name) => this.allowed.has(name)).map((name) => ({
      name,
      description: APPOINTMENT_TOOLS[name].description,
      parameters: toolParametersJsonSchema(name),
    }));
  }

  async execute(name: string, rawArguments: string, turn: ToolTurnContext): Promise<ToolCallResult> {
    const started = performance.now();
    let output: ToolOutput;
    if (!isAppointmentToolName(name) || !this.allowed.has(name)) {
      output = { status: 'unknown_tool', hint: 'Use only the tools you were given.' };
    } else {
      const parsed = parseToolArguments(name, rawArguments);
      if (!parsed.ok) {
        output = { status: 'invalid_arguments', problem: parsed.problem };
      } else {
        try {
          output = await this.dispatch(name, parsed.value, turn);
        } catch (err) {
          if (turn.signal.aborted && isAbortLike(err)) throw err; // the turn was abandoned: nothing to tell the model
          output = this.failure(err);
        }
      }
    }
    const outcome = typeof output['status'] === 'string' ? output['status'] : 'unknown';
    const speech = output[SPEAK];
    this.log.info('tool.call', { turn_id: turn.turnId, tool: name, outcome, ms: Math.round(performance.now() - started), ...(speech ? { system_speech: true } : {}) });
    return { output, outcome, ...(speech ? { speech } : {}) };
  }

  /** True for the only tool that changes data in the scheduling system. Every other tool is a read or a proposal. */
  mutates(name: string): boolean {
    return name === 'confirm_pending_action';
  }

  /**
   * Per-request context for the model: the clinic's current date and time, so "tomorrow" and "next Sunday"
   * resolve correctly, and the patients already verified in this call (from the server's own state), so the
   * model does not ask a verified caller for their identity again (observed live, plan step 7).
   */
  contextNote(): string {
    const { date, weekday, time } = this.when(this.now());
    const lines = [`التاريخ والوقت الآن في العيادة: ${weekday} ${date}، الساعة ${time} (${this.o.timeZone}). مدخلات الأدوات بالتاريخ YYYY-MM-DD والوقت HH:mm.`];
    const verified = this.verification.verifiedPatients().map((p) => `${this.refs.register('patient', p)} (${p.firstName})`);
    if (verified.length > 0) {
      lines.push(`المرضى المتحقق منهم في هذي المكالمة: ${verified.join('، ')}. لا تطلب منهم الهوية أو تاريخ الميلاد مرة ثانية، واستخدم مرجع المريض مباشرة.`);
    }
    return lines.join('\n');
  }

  /**
   * A turn ended; `heardText` is what the caller actually heard (played audio). A proposal nobody heard is
   * dropped, and a read-back becomes confirmable only once the caller heard all of it.
   */
  onTurnFinalized(turnId: string, heardAnything: boolean, heardText?: string): void {
    this.pending.onTurnFinalized(turnId, heardAnything, heardText);
  }

  /** Retries reconciliation of unknown write outcomes (e.g. at the start of a turn). Returns what got resolved. */
  async reconcileUnresolved(): Promise<{ action_ref: string; kind: string; applied: boolean }[]> {
    const resolved = await this.ledger.reconcileUnresolved();
    return resolved.map((r) => ({ action_ref: r.entry.actionRef, kind: r.entry.kind, applied: r.applied }));
  }

  /** Waits (bounded) for writes still in flight, e.g. before the session closes. */
  drain(timeoutMs: number): Promise<number> {
    return this.ledger.drain(timeoutMs);
  }

  // ─────────────────────────────── dispatch ───────────────────────────────

  private async dispatch(name: AppointmentToolName, input: unknown, turn: ToolTurnContext): Promise<ToolOutput> {
    try {
      switch (name) {
        case 'search_clinic_directory':
          return await this.searchDirectory(input as SearchClinicDirectoryInput, turn);
        case 'search_available_slots':
          return await this.searchSlots(input as SearchAvailableSlotsInput, turn);
        case 'find_patient':
          return await this.findPatient(input as FindPatientInput, turn);
        case 'list_patient_appointments':
          return await this.listAppointments(input as ListPatientAppointmentsInput, turn);
        case 'propose_registration':
          return await this.proposeRegistration(input as ProposeRegistrationInput, turn);
        case 'propose_booking':
          return await this.proposeBooking(input as ProposeBookingInput, turn);
        case 'propose_reschedule':
          return await this.proposeReschedule(input as ProposeRescheduleInput, turn);
        case 'propose_cancellation':
          return await this.proposeCancellation(input as ProposeCancellationInput, turn);
        case 'confirm_pending_action':
          return await this.confirm(input as ConfirmPendingActionInput, turn);
      }
    } catch (err) {
      if (err instanceof ToolRejection) return { status: err.status, hint: err.hint, ...err.extra };
      throw err;
    }
  }

  // ─────────────────────────────── reads ───────────────────────────────

  private async searchDirectory(input: SearchClinicDirectoryInput, turn: ToolTurnContext): Promise<Record<string, unknown>> {
    const serviceId = input.service_ref !== null ? this.resolve('service', input.service_ref).id : undefined;
    const result = await this.read(turn, (ctx) =>
      this.o.scheduling.searchDirectory(ctx, {
        ...(input.query !== null ? { text: input.query } : {}),
        kind: input.kind,
        ...(serviceId !== undefined ? { serviceId } : {}),
        limit: this.o.maxResults,
      }),
    );
    const results = result.entries.map((e) =>
      e.kind === 'service'
        ? { ref: this.refs.register('service', e.service), kind: 'service', name: e.service.name }
        : {
            ref: this.refs.register('practitioner', e.practitioner),
            kind: 'practitioner',
            name: e.practitioner.name,
            gender: e.practitioner.gender,
            services: e.practitioner.services.map((s) => ({ ref: this.refs.register('service', s), name: s.name })),
          },
    );
    return {
      status: 'ok',
      results,
      more: result.hasMore,
      ...(results.length === 0 ? { hint: 'No match. Ask the caller to rephrase, or search with kind=service and no query to list services.' } : {}),
    };
  }

  private async searchSlots(input: SearchAvailableSlotsInput, turn: ToolTurnContext): Promise<Record<string, unknown>> {
    const service = this.resolve('service', input.service_ref);
    const practitioner = input.practitioner_ref !== null ? this.resolve('practitioner', input.practitioner_ref) : undefined;
    let ignoreAppointmentId: string | undefined;
    if (input.for_appointment_ref !== null) {
      const appointment = this.ownedAppointment(input.for_appointment_ref);
      if (appointment.serviceId !== service.id) throw serviceChangeRejection();
      ignoreAppointmentId = appointment.id;
    }
    const today = this.today();
    if (!isLocalDate(input.date_from) || (input.date_to !== null && !isLocalDate(input.date_to))) {
      throw new ToolRejection('invalid_arguments', 'Dates must be real calendar dates (YYYY-MM-DD).');
    }
    const from = input.date_from < today ? today : input.date_from;
    let to = input.date_to ?? addDays(from, this.o.defaultSearchDays - 1);
    if (to < from) throw new ToolRejection('invalid_arguments', 'date_to is before date_from (or in the past).');
    if (daysBetween(from, to) + 1 > MAX_AVAILABILITY_WINDOW_DAYS) to = addDays(from, MAX_AVAILABILITY_WINDOW_DAYS - 1);

    const base = {
      serviceId: service.id,
      ...(practitioner ? { practitionerIds: [practitioner.id] } : {}),
      ...(ignoreAppointmentId !== undefined ? { ignoreAppointmentId } : {}),
    };
    const slots: AvailableSlot[] = [];
    let more = false;
    if (input.part_of_day === null) {
      const result = await this.read(turn, (ctx) =>
        this.o.scheduling.findAvailability(ctx, { ...base, from: this.startOf(from), to: this.startOf(addDays(to, 1)), limit: this.o.maxResults }),
      );
      slots.push(...result.slots);
      more = result.hasMore;
    } else {
      // One window per day, so a busy morning cannot crowd out the evening the caller asked for.
      const [startMin, endMin] = PART_OF_DAY[input.part_of_day];
      for (let day = from; daysBetween(day, to) >= 0; day = addDays(day, 1)) {
        if (slots.length >= this.o.maxResults) {
          more = true;
          break;
        }
        const window = { from: this.at(day, startMin), to: this.at(day, endMin) };
        const result = await this.read(turn, (ctx) => this.o.scheduling.findAvailability(ctx, { ...base, ...window, limit: this.o.maxResults - slots.length }));
        slots.push(...result.slots);
        if (result.hasMore) more = true;
      }
    }
    return {
      status: 'ok',
      window: { from, to },
      slots: slots.map((s) => ({
        ref: this.refs.register('slot', s),
        ...this.when(s.start),
        spoken: this.spokenWhen(s.start),
        doctor: s.practitionerName,
        service: s.serviceName,
      })),
      more,
      ...(slots.length === 0 ? { hint: 'No free time in this window. Offer another date range, part of day, or practitioner.' } : {}),
    };
  }

  private async findPatient(input: FindPatientInput, turn: ToolTurnContext): Promise<Record<string, unknown>> {
    if (this.verification.locked) return lockedOutput();
    const nationalId = input.national_id !== null ? normalizeNationalId(input.national_id) : undefined;
    const phone = input.phone !== null ? normalizePhone(input.phone) : undefined;
    // What was received is told back (the caller's own input, digit by digit): STT may have dropped a digit,
    // e.g. one of several zeros in a row (observed live).
    const heardBack = (digits: string | undefined) => (digits !== undefined && digits !== '' ? { heard: spokenDigits(digits), digits_heard: digits.replace(/\D/g, '').length } : {});
    if (input.national_id !== null && nationalId === undefined) {
      throw new ToolRejection('invalid_national_id', 'Tell the caller the digits you received (`heard`, as given) and ask for the 10-digit national ID again.', heardBack(toAsciiDigits(input.national_id).replace(/\D/g, '')));
    }
    if (input.phone !== null && phone === undefined) {
      throw new ToolRejection('invalid_phone', 'Tell the caller the digits you received (`heard`, as given) and ask for the mobile number again (10 digits starting with 05).', heardBack(phoneDigitsHeard(input.phone)));
    }
    if (nationalId === undefined && phone === undefined) throw new ToolRejection('invalid_arguments', 'Provide national_id or phone.');
    const birthDate = normalizeBirthDate(input.birth_date, this.today());
    if (birthDate === undefined) throw new ToolRejection('invalid_birth_date', 'Ask the caller to repeat the date of birth (day, month, year).');

    const candidates = await this.read(turn, (ctx) =>
      this.o.scheduling.findPatients(ctx, { ...(nationalId !== undefined ? { nationalId } : {}), ...(phone !== undefined ? { phone } : {}) }),
    );
    const outcome = this.verification.evaluate(candidates, birthDate);
    this.log.info('patient.verification', { turn_id: turn.turnId, policy: this.verificationPolicy, outcome: outcome.status });
    switch (outcome.status) {
      case 'verified':
        return { status: 'verified', patient: { ref: this.refs.register('patient', outcome.patient), first_name: outcome.patient.firstName } };
      case 'multiple':
        return { status: 'multiple', hint: 'More than one record matches. Ask for the national ID.' };
      case 'not_verified':
        // The same answer whether no record matched or the date of birth did not; `checked` is only the caller's own input.
        return {
          status: 'not_verified',
          attempts_left: outcome.attemptsLeft,
          checked: {
            ...(phone !== undefined ? { phone: spokenDigits(localPhone(phone)) } : {}),
            ...(nationalId !== undefined ? { national_id: spokenDigits(nationalId) } : {}),
            birth_date: spokenCalendarDate(birthDate),
          },
          hint: 'Could not verify. Read `checked` to the caller as given (what was received) and ask them to correct the part that is wrong. If they are a new patient, offer registration.',
        };
      case 'locked':
        return lockedOutput();
    }
  }

  private async listAppointments(input: ListPatientAppointmentsInput, turn: ToolTurnContext): Promise<Record<string, unknown>> {
    const patient = this.verifiedPatient(input.patient_ref);
    const list = await this.read(turn, (ctx) => this.o.scheduling.listAppointments(ctx, { patientId: patient.id }));
    return {
      status: 'ok',
      appointments: list.slice(0, LIST_LIMIT).map((a) => ({ ref: this.refs.register('appointment', a), ...this.describe(a) })),
      more: list.length > LIST_LIMIT,
    };
  }

  // ─────────────────────────────── proposals ───────────────────────────────

  private async proposeRegistration(input: ProposeRegistrationInput, turn: ToolTurnContext): Promise<Record<string, unknown>> {
    if (this.verification.locked) return lockedOutput();
    const nationalId = normalizeNationalId(input.national_id);
    if (nationalId === undefined) throw new ToolRejection('invalid_national_id', 'Ask the caller to repeat the 10-digit national ID.');
    const phone = normalizePhone(input.phone);
    if (phone === undefined) throw new ToolRejection('invalid_phone', 'Ask the caller to repeat the mobile number.');
    const birthDate = normalizeBirthDate(input.birth_date, this.today());
    if (birthDate === undefined) throw new ToolRejection('invalid_birth_date', 'Ask the caller to repeat the date of birth.');
    const target: ActionTarget = { kind: 'registration', patient: { fullName: input.full_name.trim(), nationalId, phone, birthDate, gender: input.gender } };
    await this.ensureNoUnresolvedWrite(actionPatientKey(target));
    // The caller's own details are read back in full (digit by digit) so STT mistakes in the digits can be caught.
    const speech =
      `للتأكيد: بفتح ملف جديد باسم ${target.patient.fullName}، رقم الهوية ${spokenDigits(nationalId)}، ` +
      `الجوال ${spokenDigits(localPhone(phone))}، تاريخ الميلاد ${spokenCalendarDate(birthDate)}. أفتح الملف؟`;
    return this.propose(target, { full_name: target.patient.fullName, national_id: nationalId, phone: localPhone(phone), birth_date: birthDate, gender: input.gender }, speech, turn);
  }

  private async proposeBooking(input: ProposeBookingInput, turn: ToolTurnContext): Promise<Record<string, unknown>> {
    const patient = this.verifiedPatient(input.patient_ref);
    const slot = this.resolve('slot', input.slot_ref);
    if (slot.start.getTime() <= this.now().getTime()) throw new ToolRejection('slot_expired', 'That time has passed. Search again.');
    const target: ActionTarget = { kind: 'booking', patientId: patient.id, slot };
    await this.ensureNoUnresolvedWrite(actionPatientKey(target));
    // No availability pre-check here: the scheduling system validates the slot atomically when the booking executes.
    const speech = `للتأكيد: موعد ${patient.firstName} في ${slot.serviceName} مع ${spokenDoctor(slot.practitionerName, slot.practitionerGender)}، ${this.spokenAt(slot.start)}. أثبّت الحجز؟`;
    return this.propose(target, { patient: patient.firstName, service: slot.serviceName, doctor: slot.practitionerName, ...this.when(slot.start) }, speech, turn);
  }

  private async proposeReschedule(input: ProposeRescheduleInput, turn: ToolTurnContext): Promise<Record<string, unknown>> {
    const appointment = this.ownedAppointment(input.appointment_ref);
    const slot = this.resolve('slot', input.new_slot_ref);
    if (slot.serviceId !== appointment.serviceId) throw serviceChangeRejection();
    if (slot.start.getTime() <= this.now().getTime()) throw new ToolRejection('slot_expired', 'That time has passed. Search again.');
    if (slot.start.getTime() === appointment.start.getTime() && slot.practitionerId === appointment.practitionerId) {
      throw new ToolRejection('same_time', 'The new time is the current appointment time. Offer a different slot.');
    }
    const target: ActionTarget = {
      kind: 'reschedule',
      patientId: appointment.patientId,
      appointmentId: appointment.id,
      ...(appointment.version !== undefined ? { version: appointment.version } : {}),
      currentStart: appointment.start,
      newSlot: slot,
    };
    await this.ensureNoUnresolvedWrite(actionPatientKey(target));
    const speech =
      `للتأكيد: بنقل موعد ${this.patientName(appointment.patientId) ?? ''} في ${appointment.serviceName} من ${this.spokenAt(appointment.start)}، ` +
      `إلى ${this.spokenAt(slot.start)} مع ${spokenDoctor(slot.practitionerName, slot.practitionerGender)}. أثبّت التغيير؟`;
    return this.propose(
      target,
      {
        patient: this.patientName(appointment.patientId),
        service: appointment.serviceName,
        from: { ...this.when(appointment.start), doctor: appointment.practitionerName },
        to: { ...this.when(slot.start), doctor: slot.practitionerName },
      },
      speech,
      turn,
    );
  }

  private async proposeCancellation(input: ProposeCancellationInput, turn: ToolTurnContext): Promise<Record<string, unknown>> {
    const appointment = this.ownedAppointment(input.appointment_ref);
    const target: ActionTarget = {
      kind: 'cancellation',
      patientId: appointment.patientId,
      appointmentId: appointment.id,
      ...(appointment.version !== undefined ? { version: appointment.version } : {}),
      ...(input.reason !== null ? { reason: input.reason } : {}),
    };
    await this.ensureNoUnresolvedWrite(actionPatientKey(target));
    const speech = `للتأكيد: بلغي ${this.spokenAppointment(appointment)}. أكيد تبي تلغيه؟`;
    return this.propose(target, { patient: this.patientName(appointment.patientId), ...this.describe(appointment) }, speech, turn);
  }

  /** Stores the action; the system itself reads `speech` to the caller and ends the turn (the model does not reword it). */
  private propose(target: ActionTarget, readBack: Record<string, unknown>, speech: string, turn: ToolTurnContext): ToolOutput {
    const action = this.pending.propose(target, readBack, speech, turn);
    this.audit(turn, 'proposed', action.ref, target.kind, action.fingerprint, 'confirmation_required');
    return {
      status: 'confirmation_required',
      action_ref: action.ref,
      read_back: readBack,
      spoken: speech,
      expires_in_seconds: Math.round(this.o.pendingActionTtlMs / 1000),
      hint: 'Nothing has changed yet. The system has read `spoken` aloud to the caller and asked for yes or no. Do not repeat it. Call confirm_pending_action only after the caller answers in their next turn.',
      [SPEAK]: speech,
    };
  }

  // ─────────────────────────────── confirmation & execution ───────────────────────────────

  private async confirm(input: ConfirmPendingActionInput, turn: ToolTurnContext): Promise<ToolOutput> {
    const result = this.pending.confirm(input.action_ref, {
      userTurn: turn.userTurn,
      callerUtterance: turn.callerUtterance,
      callerAnswer: input.caller_answer,
      turnId: turn.turnId,
    });
    if (!result.ok) {
      this.log.info('tool.audit', {
        turn_id: turn.turnId,
        phase: 'confirmation',
        action_ref: input.action_ref,
        outcome: result.code,
        model_answer: input.caller_answer,
        ...(result.classification ? { reason: result.classification.reason } : {}),
      });
      const output = confirmRejectionOutput(result.code, result.reconfirmationsLeft);
      // Asked again: the system reads the same authoritative details once more, in this turn.
      const again = this.pending.current;
      if ((result.code === 'confirmation_unclear' || result.code === 'read_back_required') && again !== undefined) {
        const speech = `${result.code === 'confirmation_unclear' ? 'ما فهمت ردّك.' : 'خلني أعيد لك التفاصيل.'} ${again.speech}`;
        return { ...output, spoken: speech, [SPEAK]: speech };
      }
      return output;
    }
    const { action } = result;
    const target = action.target;
    this.audit(turn, 'confirmed', action.ref, target.kind, action.fingerprint, 'affirm');
    if (target.kind !== 'registration' && !this.verification.isVerified(target.patientId)) {
      return { status: 'not_verified', hint: 'The patient is not verified in this call. Nothing was changed.' };
    }
    const patientKey = actionPatientKey(target);
    await this.ensureNoUnresolvedWrite(patientKey);

    // From here on the caller has said yes: work is detached from the turn so an interruption cannot abandon it.
    if (target.kind === 'reschedule' || target.kind === 'cancellation') {
      const current = await this.detachedRead((ctx) => this.o.scheduling.getAppointment(ctx, target.appointmentId));
      const changed = target.version !== undefined && current.version !== undefined && current.version !== target.version;
      if (current.patientId !== target.patientId || !ACTIVE.has(current.status) || changed) {
        this.audit(turn, 'executed', action.ref, target.kind, action.fingerprint, 'stale_action');
        return { status: 'stale_action', hint: 'The appointment changed since it was read. Nothing was changed; list the appointments again.' };
      }
    }

    const idempotencyKey = `${this.o.sessionId}:${action.ref}:${action.fingerprint}`;
    const outcome = await this.ledger.execute<WriteResult>({
      actionRef: action.ref,
      kind: target.kind,
      patientKey,
      idempotencyKey,
      run: (signal) => this.runWrite(target, idempotencyKey, signal),
      reconcile: (signal) => this.reconcileWrite(target, signal),
    });
    this.audit(turn, 'executed', action.ref, target.kind, action.fingerprint, outcome.status === 'failed' && outcome.reconciled ? 'not_applied' : outcome.status);

    if (outcome.status === 'unknown') {
      return {
        status: 'outcome_unknown',
        hint: 'It is not certain whether this change was applied. Tell the caller honestly that staff will verify it. Do not try again in this call.',
      };
    }
    if (outcome.status === 'failed') {
      if (outcome.reconciled) return { status: 'not_applied', hint: 'Checked with the system: nothing was changed. You may propose again.' };
      return this.writeFailure(outcome.error);
    }
    return this.writeSuccess(target, outcome.result);
  }

  private runWrite(target: ActionTarget, idempotencyKey: string, signal: AbortSignal): Promise<WriteResult> {
    const ctx = this.ctx(signal);
    switch (target.kind) {
      case 'registration':
        return this.o.scheduling.registerPatient(ctx, { patient: target.patient, idempotencyKey });
      case 'booking':
        return this.o.scheduling.book(ctx, { patientId: target.patientId, slot: target.slot, idempotencyKey });
      case 'reschedule':
        return this.o.scheduling.reschedule(ctx, { appointmentId: target.appointmentId, newSlot: target.newSlot, idempotencyKey });
      case 'cancellation':
        return this.o.scheduling.cancel(ctx, { appointmentId: target.appointmentId, idempotencyKey, ...(target.reason !== undefined ? { reason: target.reason } : {}) });
    }
  }

  /** Reads the system to learn whether a write with an unknown outcome was applied. */
  private async reconcileWrite(target: ActionTarget, signal: AbortSignal): Promise<ReconcileResult<WriteResult>> {
    const ctx = this.ctx(signal);
    switch (target.kind) {
      case 'registration': {
        const found = await this.o.scheduling.findPatients(ctx, { nationalId: target.patient.nationalId });
        const ours = found.find((p) => p.birthDate === target.patient.birthDate && p.fullName === target.patient.fullName);
        return ours ? { applied: true, result: ours } : { applied: false };
      }
      case 'booking': {
        const list = await this.o.scheduling.listAppointments(ctx, { patientId: target.patientId, from: target.slot.start });
        const ours = list.find((a) => a.start.getTime() === target.slot.start.getTime() && a.practitionerId === target.slot.practitionerId);
        return ours ? { applied: true, result: ours } : { applied: false };
      }
      case 'reschedule': {
        const current = await this.o.scheduling.getAppointment(ctx, target.appointmentId);
        const moved = current.start.getTime() === target.newSlot.start.getTime() && current.practitionerId === target.newSlot.practitionerId;
        return moved && ACTIVE.has(current.status) ? { applied: true, result: current } : { applied: false };
      }
      case 'cancellation': {
        const current = await this.o.scheduling.getAppointment(ctx, target.appointmentId);
        return current.status === 'cancelled' ? { applied: true, result: current } : { applied: false };
      }
    }
  }

  /** The result as the scheduling system recorded it; for appointments the system speaks it itself (authoritative date and time). */
  private writeSuccess(target: ActionTarget, result: WriteResult): ToolOutput {
    if (target.kind === 'registration') {
      const patient = result as PatientRecord;
      this.verification.markRegistered(patient);
      return { status: 'done', patient: { ref: this.refs.register('patient', patient), first_name: patient.firstName } };
    }
    const appointment = result as AppointmentRecord;
    const summary = { ref: this.refs.register('appointment', appointment), ...this.describe(appointment) };
    const said = target.kind === 'booking' ? 'تم الحجز:' : target.kind === 'reschedule' ? 'تم تغيير الموعد، وصار' : 'تم إلغاء';
    const speech = `${said} ${this.spokenAppointment(appointment)}. تبي أخدمك بشي ثاني؟`;
    const hint = 'Done and recorded by the scheduling system. The system has told the caller the result; do not repeat it.';
    return target.kind === 'cancellation'
      ? { status: 'done', cancelled: summary, spoken: speech, hint, [SPEAK]: speech }
      : { status: 'done', appointment: summary, spoken: speech, hint, [SPEAK]: speech };
  }

  private writeFailure(error: unknown): Record<string, unknown> {
    if (error instanceof SchedulingError) {
      switch (error.kind) {
        case 'slot_unavailable':
          return { status: 'slot_unavailable', hint: 'That time was just taken. Nothing was changed. Search again and offer other times.' };
        case 'already_exists':
          return {
            status: 'already_exists',
            hint: 'A record with this national ID already exists. Nothing was changed. Verify with find_patient, or offer to connect with staff.',
          };
        case 'not_found':
        case 'invalid_state':
          return { status: 'stale_action', hint: 'The appointment changed meanwhile. Nothing was changed; list the appointments again.' };
        case 'invalid_request':
          return { status: 'rejected', hint: 'The system refused the request. Nothing was changed.' };
      }
    }
    return { status: 'system_unavailable', hint: 'The scheduling system refused the request. Nothing was changed. Apologize and offer to try later or reach staff.' };
  }

  // ─────────────────────────────── helpers ───────────────────────────────

  private async ensureNoUnresolvedWrite(patientKey: string): Promise<void> {
    if (!this.ledger.blocking(patientKey)) return;
    await this.ledger.reconcileUnresolved(patientKey);
    if (this.ledger.blocking(patientKey)) {
      throw new ToolRejection(
        'previous_action_unresolved',
        'An earlier change for this patient is not confirmed yet. Do not start another one; tell the caller staff will verify it.',
      );
    }
  }

  private failure(err: unknown): Record<string, unknown> {
    this.log.warn('tool.failed', errorSummary(err));
    if (err instanceof SchedulingError) {
      if (err.kind === 'not_found') return { status: 'not_found', hint: 'That item no longer exists. Search again.' };
      return { status: 'rejected', hint: 'The system refused the request. Nothing was changed.' };
    }
    if (err instanceof ProviderError && err.kind === 'timeout') {
      return { status: 'system_timeout', hint: 'The scheduling system did not answer in time. Nothing was changed. Apologize and offer to try again.' };
    }
    return { status: 'system_unavailable', hint: 'The scheduling system is not available. Nothing was changed. Apologize and offer to try later or reach staff.' };
  }

  private async read<T>(turn: ToolTurnContext, fn: (ctx: SchedulingContext) => Promise<T>): Promise<T> {
    const deadline = withDeadline(turn.signal, this.o.readTimeoutMs, () => this.timeoutError());
    try {
      return await fn(this.ctx(deadline.signal, turn.turnId));
    } finally {
      deadline.dispose();
    }
  }

  /** A read on the execution path of a confirmed write: bounded by its deadline only, not by the turn. */
  private async detachedRead<T>(fn: (ctx: SchedulingContext) => Promise<T>): Promise<T> {
    const deadline = withDeadline(undefined, this.o.readTimeoutMs, () => this.timeoutError());
    try {
      return await fn(this.ctx(deadline.signal));
    } finally {
      deadline.dispose();
    }
  }

  private ctx(signal: AbortSignal, turnId?: string): SchedulingContext {
    return { tenant: this.o.tenant, signal, correlationId: turnId !== undefined ? `${this.o.sessionId}/${turnId}` : this.o.sessionId };
  }

  private timeoutError(): ProviderError {
    return new ProviderError(this.o.scheduling.name, 'timeout', `No answer within ${this.o.readTimeoutMs}ms`);
  }

  private resolve<K extends 'service' | 'practitioner' | 'slot'>(kind: K, ref: string): RefValues[K] {
    const value = this.refs.resolve(kind, ref);
    if (value === undefined) throw new ToolRejection('unknown_ref', `Unknown ${kind} ref '${ref}'. Use a ref returned by an earlier tool result in this call.`);
    return value;
  }

  private verifiedPatient(ref: string): PatientRecord {
    const patient = this.refs.resolve('patient', ref);
    if (patient === undefined) throw new ToolRejection('unknown_ref', `Unknown patient ref '${ref}'. Verify the patient with find_patient first.`);
    if (!this.verification.isVerified(patient.id)) throw new ToolRejection('not_verified', 'Verify the patient with find_patient first.');
    return patient;
  }

  private ownedAppointment(ref: string): AppointmentRecord {
    const appointment = this.refs.resolve('appointment', ref);
    if (appointment === undefined) throw new ToolRejection('unknown_ref', `Unknown appointment ref '${ref}'. List the patient's appointments first.`);
    if (!this.verification.isVerified(appointment.patientId)) throw new ToolRejection('not_verified', 'Verify the patient with find_patient first.');
    return appointment;
  }

  private patientName(patientId: string): string | undefined {
    return this.verification.verifiedPatient(patientId)?.firstName;
  }

  private today(): LocalDate {
    return instantToZoned(this.now(), this.o.timeZone).date;
  }

  private startOf(date: LocalDate): Date {
    return zonedToInstant(date, '00:00', this.o.timeZone);
  }

  private at(date: LocalDate, minutes: number): Date {
    return minutes >= 1440 ? this.startOf(addDays(date, 1)) : zonedToInstant(date, formatMinutes(minutes), this.o.timeZone);
  }

  private when(instant: Date): { date: LocalDate; weekday: string; time: string } {
    const local = instantToZoned(instant, this.o.timeZone);
    return { date: local.date, weekday: WEEKDAYS[local.weekday], time: local.time };
  }

  private describe(a: AppointmentRecord): Record<string, unknown> {
    return { ...this.when(a.start), spoken: this.spokenWhen(a.start), doctor: a.practitionerName, service: a.serviceName };
  }

  /** "يوم الثلاثاء ثلطعش أكتوبر، الساعة أربع مساءً" — deterministic, in the clinic's time zone. */
  private spokenAt(instant: Date): string {
    return spokenDateTime(instant, this.o.timeZone, this.now());
  }

  /** The same without "يوم"/"الساعة", for lists the model reads out: "الثلاثاء ثلطعش أكتوبر، أربع مساءً". */
  private spokenWhen(instant: Date): string {
    const local = instantToZoned(instant, this.o.timeZone);
    return `${spokenDate(local.date, Number(this.today().slice(0, 4)))}، ${spokenTime(local.time)}`;
  }

  /** "موعد عبدالله في طب الأسرة مع الدّكتور فهد العتيبي، يوم الخميس خمسطعش أكتوبر، الساعة خمس مساءً". */
  private spokenAppointment(a: AppointmentRecord): string {
    const who = this.patientName(a.patientId);
    return `موعد ${who !== undefined ? `${who} ` : ''}في ${a.serviceName} مع ${spokenDoctor(a.practitionerName, a.practitionerGender)}، ${this.spokenAt(a.start)}`;
  }

  private audit(turn: ToolTurnContext, phase: string, actionRef: string, kind: string, fingerprint: string, outcome: string): void {
    this.log.info('tool.audit', { turn_id: turn.turnId, phase, action_ref: actionRef, kind, fingerprint, outcome });
  }
}

function lockedOutput(): Record<string, unknown> {
  return { status: 'locked', hint: 'Too many failed verification attempts in this call. Offer to connect the caller with staff.' };
}

function serviceChangeRejection(): ToolRejection {
  return new ToolRejection('service_change_not_allowed', 'Rescheduling keeps the same service. To change the service, cancel and book a new appointment.');
}

function confirmRejectionOutput(code: string, reconfirmationsLeft: number | undefined): Record<string, unknown> {
  switch (code) {
    case 'caller_confirmation_required':
      return { status: code, hint: 'The caller has not answered yet. The system already read the details; wait for their reply and call this only then.' };
    case 'confirmation_unclear':
      return {
        status: code,
        attempts_left: reconfirmationsLeft,
        hint: 'The reply was not a clear yes. Nothing was changed. The system read the details again and asked for yes or no; wait for the reply. If they want something different, propose again.',
      };
    case 'read_back_required':
      return {
        status: code,
        attempts_left: reconfirmationsLeft,
        hint: 'The caller had not heard the full details (e.g. interrupted). Nothing was changed. The system read them again and asked for yes or no; wait for the reply.',
      };
    case 'declined':
      return { status: code, hint: 'The caller said no. Nothing was changed.' };
    default:
      return { status: code, hint: 'This action can no longer be confirmed. Nothing was changed. Propose again if the caller still wants it.' };
  }
}

function localPhone(e164: string): string {
  return e164.startsWith('+966') ? `0${e164.slice(4)}` : e164;
}
