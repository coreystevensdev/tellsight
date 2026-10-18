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

const stats = [trend, breakdown];
const allowedStatIds = new Set(stats.map((s) => statInstanceId(s, DATASET_ID)));
const trendId = statInstanceId(trend, DATASET_ID);

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
    const result = validateProposalCandidate(candidate(), allowedStatIds, stats);
    expect(result).not.toBeNull();
    expect(result!.evidence).toEqual([trendId]);
  });

  it('keeps a proposal that quotes no figures at all', () => {
    const result = validateProposalCandidate(
      candidate({ explanation: 'Sales are climbing steadily.', recommendation: 'Worth a look.' }),
      allowedStatIds,
      stats,
    );
    expect(result).not.toBeNull();
  });

  it('drops a schema failure', () => {
    expect(validateProposalCandidate(candidate({ confidence: 4 }), allowedStatIds, stats)).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('schema validation'));
  });

  it('drops evidence that cites a stat outside the prompt', () => {
    const result = validateProposalCandidate(
      candidate({ evidence: ['9:trend:Imaginary:0'] }),
      allowedStatIds,
      stats,
    );
    expect(result).toBeNull();
    expect(logger.info).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('out-of-scope'));
  });

  it('trims whitespace the model picks up copying a cite token', () => {
    const result = validateProposalCandidate(candidate({ evidence: [` ${trendId} `] }), allowedStatIds, stats);
    expect(result).not.toBeNull();
    expect(result!.evidence).toEqual([trendId]);
  });

  // The gap this file was written for. Citing a real stat says nothing about
  // whether the numbers in the prose came from it, and before the figure check
  // a proposal could cite a valid id and quote an invented total.
  it('drops a figure that is not derivable from the stats, even with valid evidence', () => {
    const result = validateProposalCandidate(
      candidate({ explanation: 'Sales grew 15% and now total $47,500 for the period.' }),
      allowedStatIds,
      stats,
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
        allowedStatIds,
        stats,
      ),
    ).toBeNull();
    expect(
      validateProposalCandidate(candidate({ title: 'Sales reached $91,400' }), allowedStatIds, stats),
    ).toBeNull();
  });

  it('allows a percentage the stats support', () => {
    const result = validateProposalCandidate(
      candidate({ explanation: 'Marketing is 72% of spend this period.' }),
      allowedStatIds,
      stats,
    );
    expect(result).not.toBeNull();
  });
});
