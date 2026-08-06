export {
  FINDING_KINDS,
  ACTION_MUTATES,
  actionMutates,
  agentProposalSchema,
} from './proposal.js';

export type { AgentProposal, ProposedAction, MoneyImpact, FindingKind, AgentProposalResponse } from './proposal.js';

export { BANNED_IMPERATIVES, hasDirectiveLanguage, findDirectiveLanguage } from './constants.js';

export { routeProposal, DEFAULT_MIN_CONFIDENCE } from './gate.js';

export type { GateLane, GateConfig, GateContext, GateDecision } from './gate.js';

export { deriveDedupKey } from './dedup.js';

export type { DedupInput } from './dedup.js';
