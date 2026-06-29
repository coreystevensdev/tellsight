export {
  FINDING_KINDS,
  ACTION_MUTATES,
  actionMutates,
  agentProposalSchema,
} from './proposal.js';

export type { AgentProposal, ProposedAction, MoneyImpact, FindingKind } from './proposal.js';

export { routeProposal } from './gate.js';

export type { GateLane, GateConfig, GateContext, GateDecision } from './gate.js';

export { deriveDedupKey } from './dedup.js';

export type { DedupInput } from './dedup.js';
