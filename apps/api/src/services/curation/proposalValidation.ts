import { agentProposalSchema, type AgentProposal } from 'shared/agent';

import { logger } from '../../lib/logger.js';
import { validateSummary } from './validator.js';
import type { ComputedStat } from './types.js';

// Schema validation, evidence-scope check, and figure check for one candidate
// proposal. Called from the tool-call path (curation/proposals.ts). Logs and
// returns null rather than throwing, a partial result is more useful than a hard
// failure when only some of a batch is bad.
export function validateProposalCandidate(
  candidate: unknown,
  allowedStatIds: Set<string>,
  stats: ComputedStat[],
): AgentProposal | null {
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

  // The scope check above proves the proposal cited real stats. It says nothing
  // about whether the numbers in the prose came from them, which is the failure
  // the dashboard summary has had covered since validateSummary existed and this
  // path never did.
  //
  // The dashboard can only flag: by the time the full text exists it has already
  // streamed to the browser. A proposal is a complete object before anything
  // uses it, so the same check can reject here. Any unmatched figure is enough,
  // where a summary tolerates up to three, because a proposal is a title and a
  // couple of sentences and the prompt explicitly allows proposing nothing.
  //
  // Allowed values come from the whole pipeline stat set rather than just this
  // proposal's evidence. Scoping it to the evidence would also catch a figure
  // lifted from an uncited stat, but a finding that connects two stats while
  // citing one is a real shape, and dropping those is a worse trade than missing
  // that case.
  const prose = [result.data.title, result.data.explanation, result.data.recommendation]
    .filter((part): part is string => Boolean(part))
    .join('\n');
  const figures = validateSummary(prose, stats);
  if (figures.unmatchedNumbers.length > 0) {
    logger.info(
      {
        title: result.data.title,
        evidence: trimmedEvidence,
        numbersChecked: figures.numbersChecked,
        unmatched: figures.unmatchedNumbers,
      },
      'agent proposal dropped: figures not derivable from the computed stats',
    );
    return null;
  }

  return { ...result.data, evidence: trimmedEvidence };
}
