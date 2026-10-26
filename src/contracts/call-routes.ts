import { z } from 'zod';

/**
 * Telephony routes: which agent profile answers which dialed number (or SIP address).
 * One clinic per key. A key that is not listed is rejected, never guessed (tenant isolation).
 */
export const callRoutesSchema = z
  .object({
    routes: z
      .array(
        z
          .object({
            /** Matched exactly against what the gateway reports as dialed. */
            key: z.string().trim().min(1),
            /** Agent profile directory, as for MUJEEB_AGENT_PROFILE. */
            agentProfile: z.string().trim().min(1),
            note: z.string().optional(),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

export type CallRoutesFile = z.infer<typeof callRoutesSchema>;
