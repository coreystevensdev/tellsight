import { agentProposalSchema, type AgentProposal } from 'shared/agent';

import { logger } from '../../lib/logger.js';

// Validates and filters raw LLM output from the agent prompt. Returns only
// proposals that pass schema validation and cite evidence exclusively from the
// allowedStatIds set the model was given. Anything else is logged and dropped
// rather than erroring -- a partial result is more useful than a hard failure
// when the model produces a mix of good and bad proposals.
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
    const result = agentProposalSchema.safeParse(item);
    if (!result.success) {
      logger.warn({ errors: result.error.flatten() }, 'agent proposal failed schema validation');
      continue;
    }

    const outOfScope = result.data.evidence.filter((id) => !allowedStatIds.has(id));
    if (outOfScope.length > 0) {
      logger.info(
        { outOfScope, title: result.data.title },
        'agent proposal dropped: evidence cites out-of-scope stat IDs',
      );
      continue;
    }

    proposals.push(result.data);
  }

  return proposals;
}
