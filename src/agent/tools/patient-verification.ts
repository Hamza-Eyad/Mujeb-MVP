import type { LocalDate } from '../../core/zoned-time.js';
import type { PatientRecord } from '../../ports/scheduling.js';

/**
 * DEVELOPMENT-ONLY patient verification (DECISIONS A17): a national ID or phone number plus date of
 * birth. This is NOT production-grade authentication — anyone who knows those facts passes. The
 * production policy is an open decision (D2). One instance per session.
 */

export const DEV_VERIFICATION_POLICY = 'dev-identifier-dob';
export type VerificationPolicyName = typeof DEV_VERIFICATION_POLICY;

export type VerificationOutcome =
  | { status: 'verified'; patient: PatientRecord }
  /** Several records match even with the date of birth (e.g. twins on one phone): ask for the national ID. */
  | { status: 'multiple' }
  /** Same answer for "no such patient" and "wrong date of birth", so callers cannot probe records. */
  | { status: 'not_verified'; attemptsLeft: number }
  | { status: 'locked' };

export class DevIdentifierDobVerification {
  readonly policy: VerificationPolicyName = DEV_VERIFICATION_POLICY;
  readonly productionGrade = false;
  private readonly maxFailures: number;
  private failures = 0;
  private readonly verified = new Map<string, PatientRecord>();

  constructor(options?: { maxFailures?: number }) {
    this.maxFailures = options?.maxFailures ?? 3;
  }

  get locked(): boolean {
    return this.failures >= this.maxFailures;
  }

  /** Decides from the candidates the scheduling system returned for the identifier. */
  evaluate(candidates: readonly PatientRecord[], birthDate: LocalDate): VerificationOutcome {
    if (this.locked) return { status: 'locked' };
    const matches = candidates.filter((c) => c.birthDate === birthDate);
    if (matches.length === 1 && matches[0]) {
      this.verified.set(matches[0].id, matches[0]);
      return { status: 'verified', patient: matches[0] };
    }
    if (matches.length > 1) return { status: 'multiple' };
    this.failures += 1;
    return this.locked ? { status: 'locked' } : { status: 'not_verified', attemptsLeft: this.maxFailures - this.failures };
  }

  /** A patient registered in this session (they supplied all the data themselves) counts as verified. */
  markRegistered(patient: PatientRecord): void {
    this.verified.set(patient.id, patient);
  }

  isVerified(patientId: string): boolean {
    return this.verified.has(patientId);
  }

  verifiedPatient(patientId: string): PatientRecord | undefined {
    return this.verified.get(patientId);
  }

  /** Every patient verified (or registered) in this session, in order. */
  verifiedPatients(): PatientRecord[] {
    return [...this.verified.values()];
  }
}
