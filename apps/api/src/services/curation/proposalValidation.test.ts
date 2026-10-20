import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { logger } from '../../lib/logger.js';
import { statInstanceId } from './computation.js';
import { validateProposalCandidate } from './proposalValidation.js';
import { StatType } from './types.js';
import type { ComputedStat } from './types.js';

const DATASET_ID = 1;

// Mirrors proposals.test.ts so a figure allowed there is allowed here.
const trend: ComputedStat = {
  statType: StatType.Trend,
  category: 'Sales',
  value: 0.15,
  details: { slope: 0.15, intercept: 100, growthPercent: 15, dataPoints: 6, firstValue: 400, lastValue: 460 },
};
const breakdown: ComputedStat = {
  statType: StatType.CategoryBreakdown,
  category: 'Marketing',
  value: 3000,
  details: { percentage: 72, absoluteTotal: 3000, transactionCount: 10, min: 100, max: 900 },
};

// A cash-flow stat is the only one of these three that declares a direction, so
// it is what the movement check actually exercises.
const cashFlow: ComputedStat = {
  statType: StatType.CashFlow,
  category: 'Overall',
  value: -2100,
  details: { monthlyNet: -2100, trailingMonths: 6, direction: 'burning', monthsBurning: 4, recentMonths: [] },
};

const stats = [trend, breakdown, cashFlow];
// Annotated, because inference narrows the value type to the union of the three
// concrete members and then rejects a fourth stat type added inside a test.
const statsById = new Map<string, ComputedStat>(stats.map((s) => [statInstanceId(s, DATASET_ID), s]));
const trendId = statInstanceId(trend, DATASET_ID);
const cashFlowId = statInstanceId(cashFlow, DATASET_ID);

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'trend',
    severity: 'notice',
    title: 'Sales are trending up',
    explanation: 'Sales grew 15% across the period.',
    recommendation: 'You might consider whether the pace is sustainable.',
    confidence: 0.8,
    evidence: [trendId],
    dedupKey: 'trend:sales',
    period: '2026-W26',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('validateProposalCandidate', () => {
  it('keeps a proposal whose figures all come from the stats', () => {
    const result = validateProposalCandidate(candidate(), statsById);
    expect(result).not.toBeNull();
    expect(result!.evidence).toEqual([trendId]);
  });

  it('keeps a proposal that quotes no figures at all', () => {
    const result = validateProposalCandidate(
      candidate({ explanation: 'Sales are climbing steadily.', recommendation: 'Worth a look.' }),
      statsById,
    );
    expect(result).not.toBeNull();
  });

  it('drops a schema failure', () => {
    expect(validateProposalCandidate(candidate({ confidence: 4 }), statsById)).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('schema validation'));
  });

  it('drops evidence that cites a stat outside the prompt', () => {
    const result = validateProposalCandidate(
      candidate({ evidence: ['9:trend:Imaginary:0'] }),
      statsById,
    );
    expect(result).toBeNull();
    expect(logger.info).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('out-of-scope'));
  });

  it('trims whitespace the model picks up copying a cite token', () => {
    const result = validateProposalCandidate(candidate({ evidence: [` ${trendId} `] }), statsById);
    expect(result).not.toBeNull();
    expect(result!.evidence).toEqual([trendId]);
  });

  // The gap this file was written for. Citing a real stat says nothing about
  // whether the numbers in the prose came from it, and before the figure check
  // a proposal could cite a valid id and quote an invented total.
  it('drops a figure that is not derivable from the stats, even with valid evidence', () => {
    const result = validateProposalCandidate(
      candidate({ explanation: 'Sales grew 15% and now total $47,500 for the period.' }),
      statsById,
    );
    expect(result).toBeNull();
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ unmatched: expect.arrayContaining([expect.objectContaining({ raw: '$47,500' })]) }),
      expect.stringContaining('not derivable'),
    );
  });

  it('checks the recommendation and the title, not just the explanation', () => {
    expect(
      validateProposalCandidate(
        candidate({ recommendation: 'You might consider the $88,123 shortfall.' }),
        statsById,
      ),
    ).toBeNull();
    expect(
      validateProposalCandidate(candidate({ title: 'Sales reached $91,400' }), statsById),
    ).toBeNull();
  });

  it('allows a percentage the stats support', () => {
    const result = validateProposalCandidate(
      candidate({ explanation: 'Marketing is 72% of spend this period.' }),
      statsById,
    );
    expect(result).not.toBeNull();
  });
});

// ADR 0003: direction is checked by literal comparison against the token the
// stat declares, never by mapping onto a shared up/down vocabulary.
describe('movement', () => {
  it('keeps a proposal echoing the cited stat\'s own token', () => {
    const result = validateProposalCandidate(
      candidate({ evidence: [cashFlowId], movement: 'burning', explanation: 'Cash is going out faster than it comes in.' }),
      statsById,
    );
    expect(result).not.toBeNull();
    expect(result!.movement).toBe('burning');
  });

  it('drops a movement that contradicts the cited stat', () => {
    const result = validateProposalCandidate(
      candidate({ evidence: [cashFlowId], movement: 'surplus', explanation: 'Cash is going out faster than it comes in.' }),
      statsById,
    );
    expect(result).toBeNull();
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ movement: 'surplus', statDirection: 'burning' }),
      expect.stringContaining('contradicts'),
    );
  });

  it('drops a movement stated for a stat that declares no direction', () => {
    const result = validateProposalCandidate(
      candidate({ evidence: [trendId], movement: 'up' }),
      statsById,
    );
    expect(result).toBeNull();
    expect(logger.info).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('declare no direction'),
    );
  });

  it('omitting movement is always fine, including for a directional stat', () => {
    const result = validateProposalCandidate(
      candidate({ evidence: [cashFlowId], explanation: 'Cash is going out faster than it comes in.' }),
      statsById,
    );
    expect(result).not.toBeNull();
  });

  // The rule that keeps "margin shrank while revenue grew" legal. Two
  // direction-bearing stats cited is ambiguous rather than wrong, so no comparison.
  it('skips the comparison when more than one direction-bearing stat is cited', () => {
    const margin: ComputedStat = {
      statType: StatType.MarginTrend,
      category: 'Overall',
      value: -3,
      details: {
        recentMarginPercent: 19,
        priorMarginPercent: 22,
        direction: 'shrinking',
        revenueGrowthPercent: 4,
        expenseGrowthPercent: 11,
      },
    };
    const withMargin = new Map(statsById);
    withMargin.set(statInstanceId(margin, DATASET_ID), margin);

    const result = validateProposalCandidate(
      candidate({
        // Deliberately the SECOND cited stat's token. With 'burning' here the
        // naive comparison would also pass, because it reads directions[0],
        // and the test would prove nothing.
        evidence: [cashFlowId, statInstanceId(margin, DATASET_ID)],
        movement: 'shrinking',
        explanation: 'Cash is going out while the margin narrows.',
      }),
      withMargin,
    );
    expect(result).not.toBeNull();
  });
});
