import { z } from 'zod';

/**
 * The slice of FHIR R4 + Medplum scheduling extensions this adapter reads. Schemas validate only the
 * fields Mujeeb relies on and keep everything else (`looseObject`), so a proposed Appointment from
 * `$find` can be sent back to `$book` unchanged. Medplum's scheduling API is Beta: shapes here are
 * pinned by fixtures in tests/integration/medplum-adapter.test.ts.
 */

export const FHIR_TIMEZONE_EXTENSION = 'http://hl7.org/fhir/StructureDefinition/timezone';
export const SCHEDULING_PARAMETERS_EXTENSION = 'https://medplum.com/fhir/StructureDefinition/SchedulingParameters';
export const SERVICE_TYPE_REFERENCE_EXTENSION = 'https://medplum.com/fhir/service-type-reference';
export const CANCELLATION_REASON_SYSTEM = 'http://terminology.hl7.org/CodeSystem/appointment-cancellation-reason';

const reference = z.looseObject({ reference: z.string().optional(), display: z.string().optional() });
const extension = z.looseObject({ url: z.string() });
const coding = z.looseObject({ system: z.string().optional(), code: z.string().optional(), display: z.string().optional() });
const codeableConcept = z.looseObject({ text: z.string().optional(), coding: z.array(coding).optional(), extension: z.array(extension).optional() });
const identifier = z.looseObject({ system: z.string().optional(), value: z.string().optional() });
const meta = z.looseObject({ versionId: z.string().optional() });
const humanName = z.looseObject({ text: z.string().optional(), given: z.array(z.string()).optional(), family: z.string().optional(), use: z.string().optional() });

export const operationOutcomeSchema = z.looseObject({
  resourceType: z.literal('OperationOutcome'),
  issue: z
    .array(
      z.looseObject({
        severity: z.string().optional(),
        code: z.string().optional(),
        details: z.looseObject({ text: z.string().optional() }).optional(),
        diagnostics: z.string().optional(),
      }),
    )
    .default([]),
});

export const patientSchema = z.looseObject({
  resourceType: z.literal('Patient'),
  id: z.string(),
  meta: meta.optional(),
  name: z.array(humanName).optional(),
  birthDate: z.string().optional(),
  gender: z.string().optional(),
  telecom: z.array(z.looseObject({ system: z.string().optional(), value: z.string().optional() })).optional(),
  identifier: z.array(identifier).optional(),
});

export const practitionerSchema = z.looseObject({
  resourceType: z.literal('Practitioner'),
  id: z.string(),
  name: z.array(humanName).optional(),
  gender: z.string().optional(),
});

export const healthcareServiceSchema = z.looseObject({
  resourceType: z.literal('HealthcareService'),
  id: z.string(),
  name: z.string().optional(),
  active: z.boolean().optional(),
  type: z.array(codeableConcept).optional(),
  specialty: z.array(codeableConcept).optional(),
  extension: z.array(extension).optional(),
});

export const scheduleSchema = z.looseObject({
  resourceType: z.literal('Schedule'),
  id: z.string(),
  active: z.boolean().optional(),
  actor: z.array(reference).default([]),
  serviceType: z.array(codeableConcept).optional(),
});

export const appointmentSchema = z.looseObject({
  resourceType: z.literal('Appointment'),
  /** Absent on proposed appointments returned by `$find` (they are not stored). */
  id: z.string().optional(),
  meta: meta.optional(),
  status: z.string(),
  start: z.string().optional(),
  end: z.string().optional(),
  participant: z.array(z.looseObject({ actor: reference.optional(), status: z.string().optional() })).default([]),
  serviceType: z.array(codeableConcept).optional(),
  cancelationReason: codeableConcept.optional(),
  identifier: z.array(identifier).optional(),
  contained: z.array(z.looseObject({ resourceType: z.string(), schedule: reference.optional() })).optional(),
});

export const bundleSchema = z.looseObject({
  resourceType: z.literal('Bundle'),
  type: z.string().optional(),
  entry: z.array(z.looseObject({ resource: z.unknown().optional(), response: z.looseObject({ status: z.string().optional(), location: z.string().optional() }).optional() })).default([]),
  link: z.array(z.looseObject({ relation: z.string(), url: z.string() })).default([]),
});

export const parametersSchema = z.looseObject({
  resourceType: z.literal('Parameters'),
  parameter: z.array(z.looseObject({ name: z.string(), resource: z.unknown().optional() })).default([]),
});

export const tokenResponseSchema = z.looseObject({ access_token: z.string().min(1), expires_in: z.number().positive() });

export type FhirPatient = z.infer<typeof patientSchema>;
export type FhirPractitioner = z.infer<typeof practitionerSchema>;
export type FhirHealthcareService = z.infer<typeof healthcareServiceSchema>;
export type FhirSchedule = z.infer<typeof scheduleSchema>;
export type FhirAppointment = z.infer<typeof appointmentSchema>;
export type FhirBundle = z.infer<typeof bundleSchema>;
export type CodeableConcept = z.infer<typeof codeableConcept>;
export type HumanName = z.infer<typeof humanName>;

// ─────────────────────────────── helpers ───────────────────────────────

/** `Type/id` → id when the reference points at `type`. */
export function idFromReference(ref: string | undefined, type: string): string | undefined {
  if (ref === undefined) return undefined;
  const [kind, id, ...rest] = ref.split('/');
  return kind === type && id !== undefined && id !== '' && rest.length === 0 ? id : undefined;
}

/** HealthcareService IDs referenced through the Medplum service-type-reference extension. */
export function referencedServiceIds(serviceTypes: readonly CodeableConcept[] | undefined): string[] {
  const ids: string[] = [];
  for (const cc of serviceTypes ?? []) {
    for (const ext of cc.extension ?? []) {
      if (ext.url !== SERVICE_TYPE_REFERENCE_EXTENSION) continue;
      const id = idFromReference(asRecord(ext['valueReference'])?.['reference'] as string | undefined, 'HealthcareService');
      if (id !== undefined && !ids.includes(id)) ids.push(id);
    }
  }
  return ids;
}

/** Appointment duration in minutes from a HealthcareService's SchedulingParameters, when set. */
export function schedulingDurationMinutes(service: FhirHealthcareService): number | undefined {
  for (const ext of service.extension ?? []) {
    if (ext.url !== SCHEDULING_PARAMETERS_EXTENSION) continue;
    for (const sub of asArray(ext['extension'])) {
      const record = asRecord(sub);
      if (record?.['url'] !== 'duration') continue;
      const duration = asRecord(record['valueDuration']);
      const value = typeof duration?.['value'] === 'number' ? duration['value'] : undefined;
      if (value === undefined) continue;
      return duration?.['unit'] === 'h' ? value * 60 : value;
    }
  }
  return undefined;
}

/** Display text of a person's first name entry. */
export function displayName(names: readonly HumanName[] | undefined): string {
  const first = names?.[0];
  if (!first) return '';
  return first.text?.trim() || [...(first.given ?? []), first.family ?? ''].join(' ').trim();
}

/** Every text a person is known by (all name entries), for search. */
export function allNames(names: readonly HumanName[] | undefined): string[] {
  return (names ?? []).map((n) => n.text?.trim() || [...(n.given ?? []), n.family ?? ''].join(' ').trim()).filter((t) => t !== '');
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
