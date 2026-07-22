import { z } from 'zod';

// One request shape for both tiers: appliesGoingForward: false (default) is
// the always-on Tier 1 annotation, appliesGoingForward: true is the Tier 2
// review request. Same note field either way, it's the human-readable record
// in both cases, only the downstream handling differs.
export const createStatCorrectionSchema = z.object({
  statInstanceId: z.string().min(1),
  datasetId: z.number().int().positive(),
  note: z.string().min(1).max(1000),
  appliesGoingForward: z.boolean().optional().default(false),
});

const approveStatCorrectionSchema = z.object({
  status: z.literal('approved'),
  // The admin picks the window at approval time, not a fixed default, since
  // there's no single duration that fits every correction (see intent-contract).
  expiresInDays: z.number().int().min(1).max(365),
});

const rejectStatCorrectionSchema = z.object({
  status: z.literal('rejected'),
});

export const resolveStatCorrectionSchema = z.discriminatedUnion('status', [
  approveStatCorrectionSchema,
  rejectStatCorrectionSchema,
]);

export type CreateStatCorrectionInput = z.infer<typeof createStatCorrectionSchema>;
export type ResolveStatCorrectionInput = z.infer<typeof resolveStatCorrectionSchema>;
