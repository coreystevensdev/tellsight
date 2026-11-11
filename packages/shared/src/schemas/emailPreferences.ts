import { z } from 'zod';

// Pro-only and user-scoped, both deliberate. Cadence enum
// matches the digest_preferences.cadence CHECK constraint. The shared schema
// is the single source of truth: the frontend form imports it for client-side
// validation, the backend route imports it for body parsing.

export const digestCadenceSchema = z.enum(['weekly', 'monthly', 'off']);
export type DigestCadence = z.infer<typeof digestCadenceSchema>;

export const updateEmailPreferencesSchema = z
  .object({
    cadence: digestCadenceSchema,
    timezone: z.string().min(1).max(64),
  })
  .strict();
export type UpdateEmailPreferencesInput = z.infer<typeof updateEmailPreferencesSchema>;

export const emailPreferencesResponseSchema = z.object({
  cadence: digestCadenceSchema,
  timezone: z.string(),
  unsubscribedAt: z.string().nullable(),
  lastSentAt: z.string().nullable(),
});
export type EmailPreferencesResponse = z.infer<typeof emailPreferencesResponseSchema>;
