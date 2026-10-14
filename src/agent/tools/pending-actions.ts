import { createHash } from 'node:crypto';
import { normalizeArabic } from '../../core/arabic-text.js';
import type { AvailableSlot, NewPatient } from '../../ports/scheduling.js';
import { type CallerAnswer, type ConfirmableAction, type ConfirmationResult, classifyConfirmation, resolveConfirmation } from './confirmation-classifier.js';
import { MONTH_NAMES, WEEKDAY_NAMES } from './spoken-arabic.js';

/**
 * Server-side pending actions (DECISIONS A16). A `propose_*` tool stores exactly what will be executed;
 * `confirm_pending_action` may execute it only when every check below passes. The model can name the
 * action but cannot change its payload, confirm in the same turn, or supply the caller's words.
 *
 * The read-back is part of the action: the system speaks `speech` itself (never the model), and a yes
 * counts only if the caller heard that whole sentence, and no other date or time, in the turn it was
 * spoken (`onTurnFinalized` with the played text). Otherwise the details are read again first.
 */

export type ActionTarget =
  | { kind: 'registration'; patient: NewPatient }
  | { kind: 'booking'; patientId: string; slot: AvailableSlot }
  | { kind: 'reschedule'; patientId: string; appointmentId: string; version?: string; currentStart: Date; newSlot: AvailableSlot }
  | { kind: 'cancellation'; patientId: string; appointmentId: string; version?: string; reason?: string };

export interface PendingAction {
  readonly ref: string;
  readonly target: ActionTarget;
  /** Short hash binding tenant, session, operation, patient and target; part of the idempotency key. */
  readonly fingerprint: string;
  /** What the caller is asked to confirm, as data (shown to the model). */
  readonly readBack: Record<string, unknown>;
  /** The authoritative read-back sentence, spoken by the system itself. */
  readonly speech: string;
  /** The turn whose reply may confirm this action is `armedInUserTurn + 1`. */
  armedInUserTurn: number;
  readonly proposedInTurnId: string;
  /** The turn in which `speech` was last spoken, and whether the caller provably heard it there. */
  spokenInTurnId: string;
  heard: boolean;
  expiresAt: number;
  reconfirmations: number;
}

export type ConfirmRejection =
  /** Same turn as the proposal: the caller has not answered yet. Nothing consumed. */
  | 'caller_confirmation_required'
  /** Not a clear yes. Nothing executed; re-armed for the next turn while attempts remain. */
  | 'confirmation_unclear'
  /** The caller did not provably hear the read-back (interrupted, or other details spoken with it). Read again; re-armed. */
  | 'read_back_required'
  /** A clear no. The action is discarded. */
  | 'declined'
  /** Too old (time or turns), too many unclear replies, or the proposing turn was never heard. */
  | 'expired'
  /** A newer proposal replaced it. */
  | 'superseded'
  /** Already confirmed once. */
  | 'already_used'
  | 'unknown_action';

export type ConfirmResult =
  | { ok: true; action: PendingAction; classification: ConfirmationResult }
  | { ok: false; code: ConfirmRejection; classification?: ConfirmationResult; reconfirmationsLeft?: number };

export interface PendingActionsOptions {
  tenantId: string;
  sessionId: string;
  ttlMs: number;
  maxReconfirmations: number;
  now: () => number;
}

type Closed = 'declined' | 'expired' | 'superseded' | 'already_used';

export class PendingActions {
  private readonly options: PendingActionsOptions;
  private pending: PendingAction | undefined;
  private readonly closed = new Map<string, Closed>();
  private sequence = 0;

  constructor(options: PendingActionsOptions) {
    this.options = options;
  }

  get current(): PendingAction | undefined {
    return this.pending;
  }

  /** Stores a new action; any earlier pending action is superseded (one pending action per session). */
  propose(target: ActionTarget, readBack: Record<string, unknown>, speech: string, turn: { userTurn: number; turnId: string }): PendingAction {
    if (this.pending) this.close(this.pending, 'superseded');
    this.sequence += 1;
    const action: PendingAction = {
      ref: `C${this.sequence}`,
      target,
      fingerprint: fingerprint(this.options.tenantId, this.options.sessionId, target),
      readBack,
      speech,
      armedInUserTurn: turn.userTurn,
      proposedInTurnId: turn.turnId,
      spokenInTurnId: turn.turnId,
      heard: false,
      expiresAt: this.options.now() + this.options.ttlMs,
      reconfirmations: 0,
    };
    this.pending = action;
    return action;
  }

  /**
   * Checks timing, that the caller heard the read-back, and the caller's reply — their own words, with the
   * model's reading of them (`callerAnswer`, see `resolveConfirmation`). On a clear yes the action is
   * consumed and returned for execution; every other outcome executes nothing.
   */
  confirm(ref: string, turn: { userTurn: number; callerUtterance: string; callerAnswer: CallerAnswer; turnId: string }): ConfirmResult {
    const key = ref.trim().toUpperCase();
    const action = this.pending;
    if (!action || action.ref !== key) return { ok: false, code: this.closed.get(key) ?? 'unknown_action' };
    if (this.options.now() > action.expiresAt) return this.reject(action, 'expired');
    if (turn.userTurn <= action.armedInUserTurn) return { ok: false, code: 'caller_confirmation_required' };
    if (turn.userTurn > action.armedInUserTurn + 1) return this.reject(action, 'expired');

    const classification = classifyConfirmation(turn.callerUtterance, actionKind(action.target));
    const decision = resolveConfirmation(classification, turn.callerAnswer);
    if (decision === 'deny') return { ...this.reject(action, 'declined'), classification };
    // A yes to details the caller did not provably hear is not consent: read them again, ask again.
    const code = !action.heard ? 'read_back_required' : decision === 'unclear' ? 'confirmation_unclear' : undefined;
    if (code !== undefined) {
      if (action.reconfirmations >= this.options.maxReconfirmations) return { ...this.reject(action, 'expired'), classification };
      action.reconfirmations += 1;
      action.armedInUserTurn = turn.userTurn; // ask again: the next reply may confirm
      action.spokenInTurnId = turn.turnId; // the read-back is spoken again in this turn
      action.heard = false;
      action.expiresAt = this.options.now() + this.options.ttlMs;
      return { ok: false, code, classification, reconfirmationsLeft: this.options.maxReconfirmations - action.reconfirmations };
    }
    this.close(action, 'already_used');
    return { ok: true, action, classification };
  }

  /**
   * A turn ended. `heardText` is what the caller actually heard of it (played audio), when known.
   * - The proposing turn was not heard at all (e.g. the caller kept talking): drop the action.
   * - The turn that spoke the read-back: the action becomes confirmable only if the whole read-back was heard,
   *   with no other date or time spoken in that turn.
   */
  onTurnFinalized(turnId: string, heardAnything: boolean, heardText?: string): void {
    const action = this.pending;
    if (!action) return;
    if (action.proposedInTurnId === turnId && !heardAnything) {
      this.close(action, 'expired');
      return;
    }
    if (action.spokenInTurnId === turnId) action.heard = heardAnything && heardText !== undefined && readBackHeard(heardText, action.speech);
  }

  private reject(action: PendingAction, code: Closed): { ok: false; code: Closed } {
    this.close(action, code);
    return { ok: false, code };
  }

  private close(action: PendingAction, how: Closed): void {
    this.closed.set(action.ref, how);
    if (this.pending === action) this.pending = undefined;
  }
}

export function actionKind(target: ActionTarget): ConfirmableAction {
  return target.kind;
}

/** Patient the action is about: a system ID, or the national ID for a registration (no ID exists yet). */
export function actionPatientKey(target: ActionTarget): string {
  return target.kind === 'registration' ? `national-id:${target.patient.nationalId}` : `patient:${target.patientId}`;
}

/** Words that name a date or a clock time. Spoken outside the read-back, they could contradict it. */
const DATE_TIME_WORDS = [...WEEKDAY_NAMES, ...MONTH_NAMES, 'الساعة'].map(compact);

/**
 * True when `heard` contains the whole read-back and no date/time word beyond the read-back's own.
 * Compared without spaces, diacritics or punctuation: played text is rebuilt from TTS alignment, whose
 * spacing between segments is not guaranteed.
 */
export function readBackHeard(heard: string, speech: string): boolean {
  const h = compact(heard);
  const s = compact(speech);
  if (s === '' || !h.includes(s)) return false;
  const rest = h.split(s).join(' ');
  return DATE_TIME_WORDS.every((w) => !rest.includes(w));
}

function compact(text: string): string {
  return normalizeArabic(text).replace(/\s+/g, '');
}

function fingerprint(tenantId: string, sessionId: string, target: ActionTarget): string {
  const subject =
    target.kind === 'registration'
      ? [target.patient.nationalId, target.patient.birthDate, target.patient.fullName, target.patient.phone, target.patient.gender]
      : target.kind === 'booking'
        ? [target.patientId, target.slot.token]
        : target.kind === 'reschedule'
          ? [target.patientId, target.appointmentId, target.version ?? '', target.newSlot.token]
          : [target.patientId, target.appointmentId, target.version ?? ''];
  return createHash('sha256').update(JSON.stringify([tenantId, sessionId, target.kind, ...subject])).digest('hex').slice(0, 16);
}
