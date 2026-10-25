import { z } from 'zod';
import { isValidTimeZone } from '../core/zoned-time.js';
import { APPOINTMENT_TOOL_NAMES, type AppointmentToolName } from './appointment-tools.js';

/** Per-tenant appointment-tool configuration (DECISIONS A16/A17). */
const appointmentToolsSchema = z.object({
  /** Tool-usage rules appended to the instructions only when tools are enabled. */
  instructionsFile: z.string().min(1),
  /** Allowlist. Default: every appointment tool. */
  allowedTools: z.array(z.enum(APPOINTMENT_TOOL_NAMES as [AppointmentToolName, ...AppointmentToolName[]])).min(1).optional(),
  /** Development-only verification (not production authentication). The only accepted value for now. */
  patientVerification: z.literal('dev-identifier-dob'),
  maxToolRounds: z.number().int().min(1).max(8).default(5),
  pendingActionTtlSec: z.number().int().min(15).max(600).default(120),
  maxReconfirmations: z.number().int().min(0).max(5).default(2),
  /** Said before the first tool of a turn when the model has not spoken yet (absent: silence). */
  waitPhrase: z.string().trim().min(1).max(60).optional(),
});

/** Per-tenant agent configuration. Phase 0 reads it from a local file; Phase 2 from storage. */
export const agentProfileSchema = z
  .object({
    tenantId: z.string().min(1),
    agentId: z.string().min(1),
    displayName: z.string().min(1),
    languageCode: z.string().min(2),
    greeting: z.string().min(1).optional(),
    /** The clinic's TTS voice. Absent: the environment default (MUJEEB_TTS_VOICE_ID). */
    voiceId: z.string().trim().min(1).optional(),
    instructionsFile: z.string().min(1),
    historyMaxTurns: z.number().int().min(1).max(50).default(12),
    /** The clinic's IANA time zone (e.g. Asia/Riyadh). Required with appointment tools. */
    timezone: z.string().refine(isValidTimeZone, { error: 'unknown IANA time zone' }).optional(),
    appointmentTools: appointmentToolsSchema.optional(),
  })
  .refine((p) => p.appointmentTools === undefined || p.timezone !== undefined, { error: 'timezone is required when appointmentTools is set', path: ['timezone'] });

export type AgentProfileFile = z.infer<typeof agentProfileSchema>;
export type AppointmentToolsProfile = Omit<z.infer<typeof appointmentToolsSchema>, 'instructionsFile'> & { instructions: string };

export interface AgentProfile extends Omit<AgentProfileFile, 'instructionsFile' | 'appointmentTools'> {
  instructions: string;
  appointmentTools?: AppointmentToolsProfile;
}
