import { describe, it, expect } from 'vitest';

import { routeProposal, type GateConfig, type GateContext } from './gate.js';
import type { AgentProposal, ProposedAction } from './proposal.js';

const cfg: GateConfig = { approvalThreshold: 1000, minConfidence: 0.6, suppressSeenDays: 14 };
const ctx = (seen: string[] = []): GateContext => ({ recentDedupKeys: new Set(seen) });

// Fills required fields with safe defaults so each test states only what it varies.
function p(over: Partial<AgentProposal> = {}): AgentProposal {
  return {
    kind: 'trend',
    severity: 'notice',
    title: 'Test finding',
    explanation: 'Something changed.',
    recommendation: 'You might consider reviewing this.',
    confidence: 0.9,
    evidence: ['stat-1'],
    dedupKey: 'default-key',
    period: '2026-W26',
    ...over,
  };
}

const action = (over: Partial<ProposedAction> = {}): ProposedAction => ({
  type: 'notify',
  targetRef: 'rec-1',
  ...over,
});

describe('routeProposal', () => {
  it('suppresses below the confidence floor', () => {
    expect(routeProposal(p({ confidence: 0.4 }), cfg, ctx()).lane).toBe('suppress');
  });

  it('auto-notifies a proposal at exactly the confidence floor (strict less-than)', () => {
    // minConfidence = 0.6; the check is `< 0.6`, so 0.6 itself must pass through
    expect(routeProposal(p({ confidence: 0.6 }), cfg, ctx()).lane).toBe('auto_notify');
  });

  it('auto-notifies a fresh informational finding', () => {
    expect(routeProposal(p(), cfg, ctx()).lane).toBe('auto_notify');
  });

  it('suppresses a finding already seen in the dedup window', () => {
    expect(routeProposal(p({ dedupKey: 'k' }), cfg, ctx(['k'])).lane).toBe('suppress');
  });

  it('routes a mutating action to approval even when small', () => {
    const proposal = p({
      action: action({ type: 'reclassify', estimatedImpact: { amount: 50, currency: 'USD' } }),
    });
    expect(routeProposal(proposal, cfg, ctx()).lane).toBe('needs_approval');
  });

  it('routes an over-threshold impact to approval', () => {
    const proposal = p({
      action: action({ type: 'notify', estimatedImpact: { amount: 9000, currency: 'USD' } }),
    });
    expect(routeProposal(proposal, cfg, ctx()).lane).toBe('needs_approval');
  });

  it('lets consequence beat dedup: a seen mutating finding still needs approval', () => {
    const proposal = p({ dedupKey: 'k', action: action({ type: 'reclassify' }) });
    expect(routeProposal(proposal, cfg, ctx(['k'])).lane).toBe('needs_approval');
  });
});
