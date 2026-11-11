import { z } from 'zod';
import { isValidTimeZone } from '../core/zoned-time.js';
import { APPOINTMENT_TOOL_NAMES, type AppointmentToolName } from './appointment-tools.js';

const waitPhraseSchema = z.string().trim().min(1).max(60);

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
  /** Said before the first tool of a turn when the model has not spoken yet (absent: silence). Older form of `waitPhrases`. */
  waitPhrase: waitPhraseSchema.optional(),
  /** Like `waitPhrase`, varied: each call hears every phrase once before any repeats (WaitPhrasePicker). */
  waitPhrases: z.array(waitPhraseSchema).min(1).max(10).optional(),
}).refine((t) => t.waitPhrase === undefined || t.waitPhrases === undefined, { error: 'use waitPhrases or waitPhrase, not both', path: ['waitPhrases'] });

/**
 * Phone calls only: fixed words (no model involved) for checking a silent line and for ending a call. The
 * timings are platform settings (MUJEEB_SILENCE_PROMPT_MS, MUJEEB_SILENCE_HANGUP_MS, MUJEEB_CALL_MAX_MS).
 */
const phoneSchema = z
  .object({
    /** Said when the caller has been silent for a while ("ألو؟ تسمعني؟"). */
    silencePromptText: z.string().trim().min(1).max(120).optional(),
    /** Said when the caller stays silent after the prompt; then the call is hung up. */
    silenceGoodbyeText: z.string().trim().min(1).max(200).optional(),
    /** Said when the call reaches its maximum length; then it is hung up. Absent: hung up without words. */
    maxDurationGoodbyeText: z.string().trim().min(1).max(200).optional(),
  })
  .refine((p) => (p.silencePromptText === undefined) === (p.silenceGoodbyeText === undefined), {
    error: 'silencePromptText and silenceGoodbyeText go together',
    path: ['silenceGoodbyeText'],
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
    /**
     * Development only (in-memory scheduling): this clinic's synthetic dataset, relative to the profile
     * directory; the loader resolves it to an absolute path. Absent: MUJEEB_SCHEDULING_DATASET.
     */
    schedulingDataset: z.string().trim().min(1).optional(),
    appointmentTools: appointmentToolsSchema.optional(),
    phone: phoneSchema.optional(),
  })
  .refine((p) => p.appointmentTools === undefined || p.timezone !== undefined, { error: 'timezone is required when appointmentTools is set', path: ['timezone'] });

export type AgentProfileFile = z.infer<typeof agentProfileSchema>;
/** As loaded: `waitPhrase` (the older single form) becomes a one-phrase `waitPhrases`. */
export type AppointmentToolsProfile = Omit<z.infer<typeof appointmentToolsSchema>, 'instructionsFile' | 'waitPhrase'> & { instructions: string };
export type PhoneProfile = z.infer<typeof phoneSchema>;

export interface AgentProfile extends Omit<AgentProfileFile, 'instructionsFile' | 'appointmentTools'> {
  instructions: string;
  appointmentTools?: AppointmentToolsProfile;
}
