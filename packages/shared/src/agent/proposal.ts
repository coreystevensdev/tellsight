import { z } from 'zod';

// The cross-boundary contract for the agent tier. The API produces proposals
// (LLM output, schema-validated on return); the web Action drawer renders them
// and shows why each was routed. Both sides import this one definition, so a
// shape change breaks both at build time instead of drifting silently.

export const FINDING_KINDS = ['reconciliation', 'trend', 'anomaly', 'threshold'] as const;

// The gate needs to know which action types touch external state. Keeping the
// flag next to the type means a new action can't be added without deciding
// whether it mutates. Unknown types fail safe to mutating, so a forgotten
// registration routes to human approval rather than running unattended.
// v1 ships only non-mutating actions; `reclassify` is the v2 write-back path,
// defined now so the gate already routes it correctly.
export const ACTION_MUTATES: Record<string, boolean> = {
  notify: false,
  createNote: false,
  flagInvoice: false, // internal flag, not a write-back to the source system
  reclassify: true,
};

export const actionMutates = (type: string): boolean => ACTION_MUTATES[type] ?? true;

const moneyImpactSchema = z.object({
  amount: z.number().nonnegative(),
  currency: z.string().length(3), // ISO 4217
});

const proposedActionSchema = z.object({
  type: z.enum(['notify', 'createNote', 'flagInvoice', 'reclassify']),
  targetRef: z.string().min(1), // internal record id, never raw data
  estimatedImpact: moneyImpactSchema.optional(),
});

// Advisory posture is a legal boundary, not a style preference: insights are
// fine, financial directives need RIA registration. Reject the directive voice
// at the contract so a stray "you should" fails validation instead of shipping.
// Must align with scripts/eval-fixtures/legal-posture.ts BANNED_IMPERATIVES.
const DIRECTIVE = /\b(you\s+(?:should|must|need\s+to|ought\s+to)|i\s+recommend|i['d]\s+recommend|i\s+suggest\s+you)\b/i;

export const agentProposalSchema = z.object({
  kind: z.enum(FINDING_KINDS),
  severity: z.enum(['info', 'notice', 'warning', 'critical']),
  title: z.string().min(1).max(120),
  explanation: z
    .string()
    .min(1)
    .refine((s) => !DIRECTIVE.test(s), 'explanation must be advisory, not directive'),
  recommendation: z
    .string()
    .min(1)
    .refine((s) => !DIRECTIVE.test(s), 'recommendation must be advisory, not directive'),
  confidence: z.number().min(0).max(1),
  evidence: z.array(z.string().min(1)).min(1), // ComputedStat ids, a subset of the prompt's allowedStatIds
  action: proposedActionSchema.optional(), // absent means informational finding, nothing to approve
  dedupKey: z.string().min(1), // stable across runs for the same finding
  period: z.string().min(1), // e.g. "2026-W26"
});

export type MoneyImpact = z.infer<typeof moneyImpactSchema>;
export type ProposedAction = z.infer<typeof proposedActionSchema>;
export type AgentProposal = z.infer<typeof agentProposalSchema>;
export type FindingKind = (typeof FINDING_KINDS)[number];
