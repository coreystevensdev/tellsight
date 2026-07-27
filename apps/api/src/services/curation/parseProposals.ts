import { agentProposalSchema, type AgentProposal } from 'shared/agent';

import { logger } from '../../lib/logger.js';

// Schema validation plus evidence-scope check for one candidate proposal.
// Shared by the free-text JSON path (parseProposals, below) and the tool-call
// path (curation/proposals.ts), so both reject a malformed or out-of-scope
// proposal the same way. Logs and returns null rather than throwing, a
// partial result is more useful than a hard failure when only some of a
// batch is bad.
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

// Parses and validates a raw JSON array of proposals via validateProposalCandidate.
// No production caller uses this today, curation/proposals.ts calls the model
// through generateTool/record_proposal instead, kept for the free-text shape
// in case a future provider or path needs it.
export function parseProposals(raw: string, allowedStatIds: Set<string>): AgentProposal[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    logger.warn({ rawSnippet: raw.slice(0, 200) }, 'agent output is not valid JSON');
    return [];
  }

  if (!Array.isArray(parsed)) {
    logger.warn({ type: typeof parsed }, 'agent output is not a JSON array');
    return [];
  }

  const proposals: AgentProposal[] = [];

  for (const item of parsed) {
    const proposal = validateProposalCandidate(item, allowedStatIds);
    if (proposal) proposals.push(proposal);
  }

  return proposals;
}
