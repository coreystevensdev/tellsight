import { describe, it, expect } from 'vitest';

import { agentProposalSchema } from '../../packages/shared/src/agent/proposal.js';
import { PROPOSAL_FIXTURES, type ProposalFixture } from './proposal-fixtures.js';

describe('PROPOSAL_FIXTURES', () => {
  it('has at least 9 fixtures', () => {
    expect(PROPOSAL_FIXTURES.length).toBeGreaterThanOrEqual(9);
  });

  it.each(PROPOSAL_FIXTURES)('$id proposal satisfies agentProposalSchema', (fixture: ProposalFixture) => {
    const result = agentProposalSchema.safeParse(fixture.proposal);
    expect(result.success, !result.success ? result.error.message : undefined).toBe(true);
  });

  it('has unique dedupKeys across all fixtures', () => {
    const dedupKeys = PROPOSAL_FIXTURES.map((f) => f.proposal.dedupKey);
    expect(new Set(dedupKeys).size).toBe(dedupKeys.length);
  });
});
