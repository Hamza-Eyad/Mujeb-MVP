import type { AppointmentRecord, AvailableSlot, PatientRecord, PractitionerInfo, ServiceInfo } from '../../ports/scheduling.js';

/**
 * Short per-session references shown to the model instead of scheduling-system IDs. The model can
 * only point at objects this session's tools returned: an invented or foreign ref resolves to nothing.
 */

export interface RefValues {
  service: ServiceInfo;
  practitioner: PractitionerInfo;
  slot: AvailableSlot;
  /** Only verified patients ever get a ref. */
  patient: PatientRecord;
  /** Only appointments of a verified patient ever get a ref. */
  appointment: AppointmentRecord;
}

export type RefKind = keyof RefValues;

const PREFIX: Record<RefKind, string> = { service: 'V', practitioner: 'D', slot: 'S', patient: 'P', appointment: 'A' };

export class SessionRefs {
  private readonly byRef = new Map<string, { kind: RefKind; value: unknown }>();
  private readonly byIdentity = new Map<string, string>();
  private readonly counters: Record<RefKind, number> = { service: 0, practitioner: 0, slot: 0, patient: 0, appointment: 0 };

  /**
   * Ref for `value`. The same identity (system ID, or slot token) always gets the same ref within the
   * session; registering again refreshes the stored value (e.g. an appointment's new time/version).
   */
  register<K extends RefKind>(kind: K, value: RefValues[K]): string {
    const identity = `${kind}:${identityOf(kind, value)}`;
    let ref = this.byIdentity.get(identity);
    if (ref === undefined) {
      this.counters[kind] += 1;
      ref = `${PREFIX[kind]}${this.counters[kind]}`;
      this.byIdentity.set(identity, ref);
    }
    this.byRef.set(ref, { kind, value });
    return ref;
  }

  resolve<K extends RefKind>(kind: K, ref: string): RefValues[K] | undefined {
    const entry = this.byRef.get(ref.trim().toUpperCase());
    return entry?.kind === kind ? (entry.value as RefValues[K]) : undefined;
  }
}

function identityOf(kind: RefKind, value: RefValues[RefKind]): string {
  if (kind === 'slot') return (value as AvailableSlot).token;
  return (value as { id: string }).id;
}
