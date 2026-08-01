// Hand-labeled AgentProposal fixtures for the gate-precision eval
// (scripts/eval-proposal-precision.ts). routeProposal() is a pure function
// with no LLM or DB dependency, so it doesn't know or care whether a
// proposal came from Claude or a human, and a fixture representing a
// realistic LLM-shaped proposal scores identically to a live-generated one.
// expectedWorthApproval is the product owner's ground truth for whether a
// needs_approval routing was actually worth a human's time; it's only
// scored for fixtures that land in the needs_approval lane.

import type { AgentProposal } from '../../packages/shared/src/agent/proposal.js';

export interface ProposalFixture {
  id: string;
  label: string;
  proposal: AgentProposal;
  expectedWorthApproval: boolean;
  seedDedup?: boolean; // seed this fixture's dedupKey into recentDedupKeys before routing
}

export const PROPOSAL_FIXTURES: ProposalFixture[] = [
  {
    id: 'tp-mutating-reclassify',
    label: 'Reconciliation mismatch with a reclassify action, genuinely worth a human look',
    proposal: {
      kind: 'reconciliation',
      severity: 'critical',
      title: 'QuickBooks and dataset totals diverge by $4,200',
      explanation:
        'The QuickBooks-synced total for October expenses is $4,200 higher than the dataset total for the same period.',
      recommendation: 'You might consider reviewing the flagged entries before closing the month.',
      confidence: 0.92,
      evidence: ['stat-recon-1'],
      action: { type: 'reclassify', targetRef: 'txn-4471', estimatedImpact: { amount: 4200, currency: 'USD' } },
      dedupKey: 'recon-2026-w30-qb-mismatch',
      period: '2026-W30',
    },
    expectedWorthApproval: true,
  },
  {
    id: 'fp-trivial-mutating',
    label: 'Mutating action on a $2 rounding difference, not worth a click',
    proposal: {
      kind: 'threshold',
      severity: 'info',
      title: 'Rounding difference flagged for reclassification',
      explanation: 'A $2 rounding difference was found between two ledger entries dated the same day.',
      recommendation: 'You might consider reclassifying this entry the next time you review the ledger.',
      confidence: 0.65,
      evidence: ['stat-thresh-2'],
      action: { type: 'reclassify', targetRef: 'txn-9981', estimatedImpact: { amount: 2, currency: 'USD' } },
      dedupKey: 'threshold-2026-w30-rounding',
      period: '2026-W30',
    },
    expectedWorthApproval: false,
  },
  {
    id: 'fresh-informational',
    label: 'Fresh trend finding with no action, routes to auto_notify',
    proposal: {
      kind: 'trend',
      severity: 'notice',
      title: 'Marketing spend pulled back three months running',
      explanation: 'Marketing spend has declined for three consecutive months, from $2,930 to $2,400.',
      recommendation: 'You might consider checking whether this was a deliberate budget change.',
      confidence: 0.85,
      evidence: ['stat-trend-3'],
      dedupKey: 'trend-2026-w30-marketing-pullback',
      period: '2026-W30',
    },
    expectedWorthApproval: false,
  },
  {
    id: 'dedup-suppressed',
    label: 'Informational anomaly already seen within the dedup window, suppressed',
    proposal: {
      kind: 'anomaly',
      severity: 'warning',
      title: 'Cash balance dipped below the seasonal average',
      explanation: 'Cash balance dropped to $8,100, below the typical range for this time of year.',
      recommendation: "You might consider comparing this against last year's seasonal low.",
      confidence: 0.8,
      evidence: ['stat-anomaly-4'],
      dedupKey: 'anomaly-2026-w29-cash-dip',
      period: '2026-W29',
    },
    expectedWorthApproval: false,
    seedDedup: true,
  },
  {
    id: 'low-confidence-suppressed',
    label: 'Below the confidence floor, suppressed before dedup or action checks run',
    proposal: {
      kind: 'trend',
      severity: 'info',
      title: 'Utilities spend shows a possible pattern',
      explanation: 'Utilities spend may be trending upward, though the signal is weak.',
      recommendation: 'You might consider revisiting this once more months of data are available.',
      confidence: 0.4,
      evidence: ['stat-trend-5'],
      dedupKey: 'trend-2026-w30-utilities-noise',
      period: '2026-W30',
    },
    expectedWorthApproval: false,
  },
  {
    id: 'consequence-overrides-dedup',
    label: 'Recurring mismatch with a mutating action, dedup seeded but consequence still wins',
    proposal: {
      kind: 'reconciliation',
      severity: 'critical',
      title: 'Recurring vendor mismatch reappears this period',
      explanation: 'The same vendor-code mismatch flagged two weeks ago has recurred this period.',
      recommendation: 'You might consider checking whether the vendor mapping needs a permanent fix.',
      confidence: 0.9,
      evidence: ['stat-recon-6'],
      action: { type: 'reclassify', targetRef: 'txn-5520', estimatedImpact: { amount: 1500, currency: 'USD' } },
      dedupKey: 'recon-2026-w28-recurring-mismatch',
      period: '2026-W30',
    },
    expectedWorthApproval: true,
    seedDedup: true,
  },
  {
    id: 'over-threshold-notify',
    label: 'Non-mutating action but impact clears the approval threshold',
    proposal: {
      kind: 'threshold',
      severity: 'warning',
      title: 'Runway projection crossed the review threshold',
      explanation: 'Projected runway impact from the current burn rate is $12,000 over the next quarter.',
      recommendation: 'You might consider reviewing the burn-rate assumptions behind this projection.',
      confidence: 0.88,
      evidence: ['stat-runway-1'],
      action: { type: 'notify', targetRef: 'stat-runway-1', estimatedImpact: { amount: 12000, currency: 'USD' } },
      dedupKey: 'threshold-2026-w30-runway-drop',
      period: '2026-W30',
    },
    expectedWorthApproval: true,
  },
  {
    id: 'non-mutating-under-threshold-notify',
    label: 'Action present but neither mutating nor over threshold, falls through to auto_notify',
    proposal: {
      kind: 'trend',
      severity: 'notice',
      title: 'Subscription spend ticked up slightly',
      explanation: 'Subscription spend rose by $80 compared to last month.',
      recommendation: 'You might consider reviewing recently added subscriptions.',
      confidence: 0.82,
      evidence: ['stat-trend-7'],
      action: { type: 'notify', targetRef: 'stat-trend-7', estimatedImpact: { amount: 80, currency: 'USD' } },
      dedupKey: 'trend-2026-w30-subscription-uptick',
      period: '2026-W30',
    },
    expectedWorthApproval: false,
  },
  {
    id: 'exact-threshold-boundary',
    label: 'Impact exactly at approvalThreshold, exercises the >= boundary',
    proposal: {
      kind: 'threshold',
      severity: 'warning',
      title: 'Vendor payment lands exactly at the review threshold',
      explanation: 'A pending vendor payment totals exactly $1,000, matching the review threshold.',
      recommendation: 'You might consider confirming this payment before it processes.',
      confidence: 0.9,
      evidence: ['stat-thresh-8'],
      action: { type: 'notify', targetRef: 'stat-thresh-8', estimatedImpact: { amount: 1000, currency: 'USD' } },
      dedupKey: 'threshold-2026-w30-exact-boundary',
      period: '2026-W30',
    },
    expectedWorthApproval: true,
  },
];
