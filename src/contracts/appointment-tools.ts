import { z } from 'zod';

/**
 * Strict schemas for the appointment tools the language model may call (plans/2026-10-12 §3.2).
 * Every field is required; optional values are `null` — the shape strict function calling expects.
 * References (`*_ref`) are short session references issued by earlier tool results, never system IDs.
 * Writes are two-step: `propose_*` changes nothing; only `confirm_pending_action` executes, and only
 * after the caller has answered in a new turn (enforced server-side, not by these descriptions).
 */

const ref = z.string().trim().min(1).max(16);
const localDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const shortText = (max: number) => z.string().trim().min(1).max(max);
/** A phone number as heard: digits, or spoken digit words ("صفر خمسة …") — long enough for 13 spoken digits. */
const phoneText = shortText(160);

export const searchClinicDirectoryInput = z.strictObject({
  query: shortText(100).nullable(),
  kind: z.enum(['service', 'practitioner', 'any']),
  service_ref: ref.nullable(),
});

export const searchAvailableSlotsInput = z.strictObject({
  service_ref: ref,
  practitioner_ref: ref.nullable(),
  date_from: localDate,
  date_to: localDate.nullable(),
  part_of_day: z.enum(['morning', 'afternoon', 'evening']).nullable(),
  for_appointment_ref: ref.nullable(),
});

/**
 * Caller details are `null` until the caller has said them: the server then asks for what is missing, so the
 * model is never pushed to fill a required field with a guess (observed live: birth date "1900-01-01").
 */
export const findPatientInput = z.strictObject({
  national_id: shortText(32).nullable(),
  phone: phoneText.nullable(),
  birth_date: localDate.nullable(),
});

export const listPatientAppointmentsInput = z.strictObject({ patient_ref: ref });

export const proposeRegistrationInput = z.strictObject({
  full_name: shortText(120).nullable(),
  national_id: shortText(32).nullable(),
  phone: phoneText.nullable(),
  birth_date: localDate.nullable(),
  /** `null` when the caller did not say it — recorded as unknown, never inferred from the name. */
  gender: z.enum(['female', 'male']).nullable(),
});

export const proposeBookingInput = z.strictObject({ patient_ref: ref, slot_ref: ref });

export const proposeRescheduleInput = z.strictObject({ appointment_ref: ref, new_slot_ref: ref });

export const proposeCancellationInput = z.strictObject({ appointment_ref: ref, reason: shortText(200).nullable() });

/** The model's reading of the caller's reply; the server also checks the caller's own words (DECISIONS A16). */
export const confirmPendingActionInput = z.strictObject({ action_ref: ref, caller_answer: z.enum(['yes', 'no', 'unclear']) });

export type SearchClinicDirectoryInput = z.infer<typeof searchClinicDirectoryInput>;
export type SearchAvailableSlotsInput = z.infer<typeof searchAvailableSlotsInput>;
export type FindPatientInput = z.infer<typeof findPatientInput>;
export type ListPatientAppointmentsInput = z.infer<typeof listPatientAppointmentsInput>;
export type ProposeRegistrationInput = z.infer<typeof proposeRegistrationInput>;
export type ProposeBookingInput = z.infer<typeof proposeBookingInput>;
export type ProposeRescheduleInput = z.infer<typeof proposeRescheduleInput>;
export type ProposeCancellationInput = z.infer<typeof proposeCancellationInput>;
export type ConfirmPendingActionInput = z.infer<typeof confirmPendingActionInput>;

export const APPOINTMENT_TOOLS = {
  search_clinic_directory: {
    description:
      "Search the clinic's services (specialties) and practitioners by name, in Arabic or English. Use it instead of guessing names. " +
      'kind=practitioner with service_ref lists the practitioners of that service. Returns refs for later tools.',
    input: searchClinicDirectoryInput,
  },
  search_available_slots: {
    description:
      'Find free appointment times for a service (optionally one practitioner) from date_from to date_to (clinic-local dates, YYYY-MM-DD). ' +
      'part_of_day: morning (before 12:00), afternoon (12:00-17:00), evening (from 17:00). For rescheduling pass for_appointment_ref. ' +
      'Returns at most 5 times, earliest first, as slot refs. A slot is not reserved until a booking is confirmed.',
    input: searchAvailableSlotsInput,
  },
  find_patient: {
    description:
      "Identify and verify the caller's patient record by national_id or phone (digits as spoken) plus birth_date (YYYY-MM-DD). " +
      'Pass null for anything the caller has not said yet; never guess. ' +
      'Returns a patient ref and first name when verified; "multiple" means ask for the national ID; "not_verified" never says why.',
    input: findPatientInput,
  },
  list_patient_appointments: {
    description: "List a verified patient's upcoming appointments, earliest first, as appointment refs.",
    input: listPatientAppointmentsInput,
  },
  propose_registration: {
    description:
      'Prepare registering a NEW patient (only after find_patient did not verify them). Changes nothing yet: read back the returned details ' +
      'and ask the caller for an explicit yes or no. Pass null for any detail the caller has not said (gender included); never guess or use a placeholder.',
    input: proposeRegistrationInput,
  },
  propose_booking: {
    description: 'Prepare booking a slot for a verified patient. Changes nothing yet: read back the returned details and ask for an explicit yes or no.',
    input: proposeBookingInput,
  },
  propose_reschedule: {
    description:
      'Prepare moving an existing appointment to a new slot of the same service. Changes nothing yet: read back and ask for an explicit yes or no.',
    input: proposeRescheduleInput,
  },
  propose_cancellation: {
    description: 'Prepare cancelling an existing appointment. Changes nothing yet: read back and ask for an explicit yes or no.',
    input: proposeCancellationInput,
  },
  confirm_pending_action: {
    description:
      "Execute the pending action after the caller has answered the read-back in their NEXT turn. caller_answer is your reading of that reply: " +
      'yes = they agree in any wording ("إيه", "ثبّت", "توكل على الله"); no = they decline; unclear = a question, a condition or anything else. ' +
      "The server also checks the caller's own words; never call it in the same turn as the proposal. Only \"done\" means the change happened.",
    input: confirmPendingActionInput,
  },
} as const;

export type AppointmentToolName = keyof typeof APPOINTMENT_TOOLS;
export const APPOINTMENT_TOOL_NAMES = Object.keys(APPOINTMENT_TOOLS) as AppointmentToolName[];

export function isAppointmentToolName(name: string): name is AppointmentToolName {
  return Object.hasOwn(APPOINTMENT_TOOLS, name);
}

/** JSON Schema for a tool's parameters, in the strict form (all fields required, no extra properties). */
export function toolParametersJsonSchema(name: AppointmentToolName): Record<string, unknown> {
  const { $schema: _ignored, ...schema } = z.toJSONSchema(APPOINTMENT_TOOLS[name].input) as Record<string, unknown>;
  return schema;
}

/** Validates raw model arguments (a JSON string). Returns a short, model-safe problem description on failure. */
export function parseToolArguments<N extends AppointmentToolName>(
  name: N,
  rawArguments: string,
): { ok: true; value: z.infer<(typeof APPOINTMENT_TOOLS)[N]['input']> } | { ok: false; problem: string } {
  let json: unknown;
  try {
    json = JSON.parse(rawArguments);
  } catch {
    return { ok: false, problem: 'arguments are not valid JSON' };
  }
  const parsed = APPOINTMENT_TOOLS[name].input.safeParse(json);
  if (!parsed.success) {
    return { ok: false, problem: parsed.error.issues.map((i) => `${i.path.join('.') || 'arguments'}: ${i.message}`).join('; ') };
  }
  return { ok: true, value: parsed.data as z.infer<(typeof APPOINTMENT_TOOLS)[N]['input']> };
}
