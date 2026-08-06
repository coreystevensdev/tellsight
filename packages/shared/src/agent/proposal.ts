import { z } from 'zod';

import { hasDirectiveLanguage } from './constants.js';

// The cross-boundary contract for the agent tier. The API produces proposals
// (LLM output, schema-validated on return); the web Action drawer renders them
// and shows why each was routed. Both sides import this one definition, so a
// shape change breaks both at build time instead of drifting silently.

export const FINDING_KINDS = ['reconciliation', 'trend', 'anomaly', 'threshold'] as const;

// Single source of truth for action types: ACTION_TYPES feeds both the Zod
// enum below and ACTION_MUTATES's key set, so the two can't drift apart.
// Record<ActionType, boolean> forces every entry here to have a mutates flag
// at compile time -- adding a type to ACTION_TYPES without registering it
// below is a type error, not a silent gap.
export const ACTION_TYPES = ['notify', 'createNote', 'flagInvoice', 'reclassify'] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

// The gate needs to know which action types touch external state. Keeping the
// flag next to the type means a new action can't be added without deciding
// whether it mutates. Unknown types fail safe to mutating, so a forgotten
// registration routes to human approval rather than running unattended.
// v1 ships only non-mutating actions; `reclassify` is the v2 write-back path,
// defined now so the gate already routes it correctly.
export const ACTION_MUTATES: Record<ActionType, boolean> = {
  notify: false,
  createNote: false,
  flagInvoice: false, // internal flag, not a write-back to the source system
  reclassify: true,
};

export const actionMutates = (type: string): boolean =>
  ACTION_MUTATES[type as ActionType] ?? true;

const moneyImpactSchema = z.object({
  amount: z.number().nonnegative(),
  currency: z.string().regex(/^[A-Z]{3}$/, 'currency must be an uppercase ISO 4217 code'),
});

const proposedActionSchema = z.object({
  type: z.enum(ACTION_TYPES),
  targetRef: z.string().min(1), // internal record id, never raw data
  estimatedImpact: moneyImpactSchema.optional(),
});

// Advisory posture is a legal boundary, not a style preference: insights are
// fine, financial directives need RIA registration. Reject the directive voice
// at the contract so a stray "you should" fails validation instead of shipping.
export const agentProposalSchema = z.object({
  kind: z.enum(FINDING_KINDS),
  severity: z.enum(['info', 'notice', 'warning', 'critical']),
  title: z.string().min(1).max(120),
  explanation: z
    .string()
    .min(1)
    .refine((s) => !hasDirectiveLanguage(s), 'explanation must be advisory, not directive'),
  recommendation: z
    .string()
    .min(1)
    .refine((s) => !hasDirectiveLanguage(s), 'recommendation must be advisory, not directive'),
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

// The row shape GET/PATCH /proposals actually returns, dates serialized to
// ISO strings over JSON. Distinct from AgentProposal (the LLM-authored
// contract before it's persisted): this is a stored, id'd row the drawer
// renders and mutates.
export interface AgentProposalResponse {
  id: number;
  orgId: number;
  kind: string;
  severity: string;
  title: string;
  explanation: string;
  recommendation: string;
  confidence: string;
  evidence: string[];
  action: ProposedAction | null;
  dedupKey: string;
  lane: string;
  period: string;
  status: 'pending' | 'approved' | 'rejected' | 'expired' | 'notified';
  createdAt: string;
  expiresAt: string;
  resolvedAt: string | null;
  resolvedByUserId: number | null;
}
