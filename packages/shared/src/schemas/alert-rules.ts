import { z } from 'zod';

export const ALERT_RULE_KINDS = [
  'runway_runs_short',
  'margin_drops',
  'cash_burn_spikes',
  'breakeven_gap_widens',
  'anomaly_fires',
] as const;

export type AlertRuleKind = (typeof ALERT_RULE_KINDS)[number];

const muteUntilSchema = z
  .string()
  .datetime()
  .nullable()
  .optional()
  .refine((v) => v == null || new Date(v).getTime() > Date.now(), {
    message: 'muteUntil must be in the future',
  });

// Every kind shares enabled + muteUntil; only threshold shape varies. Spelled
// out per variant rather than built from a shared base + .extend(), a
// z.discriminatedUnion member has to be its own ZodObject, not a merged type.
const runwayRunsShortRuleSchema = z.object({
  kind: z.literal('runway_runs_short'),
  // 24 months (2 years) is a practical UX ceiling, not a mathematical bound --
  // runway concerns beyond two years aren't an actionable "short runway" alert.
  threshold: z.object({ months: z.number().positive().max(24) }),
  enabled: z.boolean().optional(),
  muteUntil: muteUntilSchema,
});

const marginDropsRuleSchema = z.object({
  kind: z.literal('margin_drops'),
  // percent is a point-drop between two margin readings; margin can go negative
  // in a loss window (computeMarginTrend has no floor) -- .max(100) is a policy
  // choice, matching breakeven_gap_widens, not a mathematical bound.
  threshold: z.object({ percent: z.number().positive().max(100) }),
  enabled: z.boolean().optional(),
  muteUntil: muteUntilSchema,
});

const cashBurnSpikesRuleSchema = z.object({
  kind: z.literal('cash_burn_spikes'),
  // percent is a relative increase in monthly expenses with no natural upper
  // bound (a bulk purchase can push burn several multiples over the prior
  // average) -- this ceiling is set loose rather than mathematically derived.
  threshold: z.object({ percent: z.number().positive().max(1000) }),
  enabled: z.boolean().optional(),
  muteUntil: muteUntilSchema,
});

const breakevenGapWidensRuleSchema = z.object({
  kind: z.literal('breakeven_gap_widens'),
  // percent is the revenue shortfall as a percent of break-even revenue, which
  // can mathematically exceed 100 -- the cap is a policy choice treating a
  // 100%+ shortfall as already the extreme end of the alert range.
  threshold: z.object({ percent: z.number().positive().max(100) }),
  enabled: z.boolean().optional(),
  muteUntil: muteUntilSchema,
});

// Confidence bucket, not a 0-1 score, matches the confidence enum already
// used on RunwayDetails/BreakEvenDetails rather than inventing a new shape.
const anomalyFiresRuleSchema = z.object({
  kind: z.literal('anomaly_fires'),
  threshold: z.object({ confidence: z.enum(['low', 'moderate', 'high']) }),
  enabled: z.boolean().optional(),
  muteUntil: muteUntilSchema,
});

export const alertRuleSchema = z.discriminatedUnion('kind', [
  runwayRunsShortRuleSchema,
  marginDropsRuleSchema,
  cashBurnSpikesRuleSchema,
  breakevenGapWidensRuleSchema,
  anomalyFiresRuleSchema,
]);

export type AlertRuleInput = z.infer<typeof alertRuleSchema>;
export type AlertRuleThreshold = AlertRuleInput['threshold'];

// Create and update take the same full kind+threshold payload, a PUT is a
// full replace, not a merge-patch, so a threshold that no longer matches the
// rule's (possibly changed) kind is rejected the same way a create would be.
export const createAlertRuleSchema = alertRuleSchema;
export const updateAlertRuleSchema = alertRuleSchema;

export type CreateAlertRuleInput = z.infer<typeof createAlertRuleSchema>;
export type UpdateAlertRuleInput = z.infer<typeof updateAlertRuleSchema>;
