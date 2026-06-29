import type { AgentProposal } from './proposal.js';
import { actionMutates } from './proposal.js';

export type GateLane = 'auto_notify' | 'needs_approval' | 'suppress';

export interface GateConfig {
  approvalThreshold: number; // money impact at/above this needs a human
  minConfidence: number; // below this, drop the proposal
  suppressSeenDays: number; // dedup window the caller used to build recentDedupKeys
}

export interface GateContext {
  recentDedupKeys: ReadonlySet<string>; // dedupKeys seen within suppressSeenDays
}

export interface GateDecision {
  lane: GateLane;
  reason: string; // recorded on the audit row when the proposal is acted on
}

// Precedence is the policy, read top to bottom:
//   1. never act on a guess        -> confidence below floor suppresses
//   2. always stop for consequence -> a mutating action OR an over-threshold
//      impact needs a human, and this beats dedup (a big finding must not be
//      silenced because a lookalike showed last week)
//   3. don't nag                   -> a previously seen dedupKey suppresses
//   4. otherwise                   -> auto_notify
//
// The function returns a decision plus a reason; the caller does the IO and
// writes the audit row. Keeping side effects out keeps it replayable and pure.
export function routeProposal(p: AgentProposal, cfg: GateConfig, ctx: GateContext): GateDecision {
  if (p.confidence < cfg.minConfidence) {
    return { lane: 'suppress', reason: 'confidence below floor' };
  }

  if (p.action) {
    const mutates = actionMutates(p.action.type);
    const overThreshold = (p.action.estimatedImpact?.amount ?? 0) >= cfg.approvalThreshold;
    if (mutates || overThreshold) {
      const reason = mutates ? 'action mutates external state' : 'impact exceeds approval threshold';
      return { lane: 'needs_approval', reason };
    }
  }

  if (ctx.recentDedupKeys.has(p.dedupKey)) {
    return { lane: 'suppress', reason: `seen within ${cfg.suppressSeenDays} days` };
  }

  return { lane: 'auto_notify', reason: 'fresh informational finding' };
}
