import { agentProposalSchema, type AgentProposal } from 'shared/agent';

import { logger } from '../../lib/logger.js';

// Schema validation plus evidence-scope check for one candidate proposal.
// Called from the tool-call path (curation/proposals.ts). Logs and returns
// null rather than throwing, a partial result is more useful than a hard
// failure when only some of a batch is bad.
export function validateProposalCandidate(candidate: unknown, allowedStatIds: Set<string>): AgentProposal | null {
  const result = agentProposalSchema.safeParse(candidate);
  if (!result.success) {
    logger.warn({ errors: result.error.flatten() }, 'agent proposal failed schema validation');
    return null;
  }

  // Trim before scope-checking -- the model is asked to copy IDs out of
  // `[cite: id]` tokens verbatim and occasionally picks up incidental
  // whitespace, which would otherwise fail a strict Set.has() match.
  const trimmedEvidence = result.data.evidence.map((id) => id.trim());
  const outOfScope = trimmedEvidence.filter((id) => !allowedStatIds.has(id));
  if (outOfScope.length > 0) {
    logger.info(
      { outOfScope, title: result.data.title },
      'agent proposal dropped: evidence cites out-of-scope stat IDs',
    );
    return null;
  }

  return { ...result.data, evidence: trimmedEvidence };
}
