import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { ScoredInsight } from './types.js';
import { StatType } from './types.js';

vi.mock('node:fs', () => ({
  // Same pattern as assembly.test.ts: force the split-template lookup to miss
  // so the legacy single-file path renders this fixed content regardless of
  // which prompt version is requested.
  readFileSync: vi.fn((path: string) => {
    if (path.includes('-system.md') || path.includes('-user.md')) {
      const err = new Error('ENOENT: no such file (test mock)') as Error & { code: string };
      err.code = 'ENOENT';
      throw err;
    }
    return 'Agent prompt template\n{{statSummaries}}';
  }),
}));

vi.mock('../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const mockGenerateWithTools = vi.fn();
vi.mock('../aiInterpretation/claudeClient.js', () => ({
  generateWithTools: (...args: unknown[]) => mockGenerateWithTools(...args),
}));

import { logger } from '../../lib/logger.js';
import { statInstanceId } from './computation.js';
import { generateProposals } from './proposals.js';

const DATASET_ID = 1;
const NOW = new Date('2026-06-25T12:00:00Z'); // Thursday, ISO week 2026-W26

const revenueTrend: ScoredInsight = {
  stat: {
    statType: StatType.Trend,
    category: 'Sales',
    value: 0.15,
    details: { slope: 0.15, intercept: 100, growthPercent: 15, dataPoints: 6, firstValue: 400, lastValue: 460 },
  },
  score: 0.8,
  breakdown: { novelty: 0.8, actionability: 0.8, specificity: 0.8 },
};

const marketingBreakdown: ScoredInsight = {
  stat: {
    statType: StatType.CategoryBreakdown,
    category: 'Marketing',
    value: 3000,
    details: { percentage: 72, absoluteTotal: 3000, transactionCount: 10, min: 100, max: 900 },
  },
  score: 0.7,
  breakdown: { novelty: 0.7, actionability: 0.7, specificity: 0.7 },
};

const insights = [revenueTrend, marketingBreakdown];
const trendId = statInstanceId(revenueTrend.stat, DATASET_ID);
const breakdownId = statInstanceId(marketingBreakdown.stat, DATASET_ID);

function toolCall(input: Record<string, unknown>) {
  return { name: 'record_proposal', input };
}

function validInput(over: Record<string, unknown> = {}) {
  return {
    kind: 'trend',
    severity: 'notice',
    title: 'Sales trending up',
    explanation: 'Sales grew 15% over the trailing period.',
    recommendation: 'Worth investigating what drove the increase.',
    confidence: 0.85,
    evidence: [trendId],
    subject: 'sales',
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('generateProposals', () => {
  it('returns an empty array when the model calls the tool zero times', async () => {
    mockGenerateWithTools.mockResolvedValue([]);

    const result = await generateProposals(insights, DATASET_ID, null, NOW);

    expect(result).toEqual([]);
  });

  it('returns one validated proposal with a code-derived dedupKey and period', async () => {
    mockGenerateWithTools.mockResolvedValue([toolCall(validInput())]);

    const result = await generateProposals(insights, DATASET_ID, null, NOW);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      kind: 'trend',
      title: 'Sales trending up',
      dedupKey: 'trend:sales:default',
      period: '2026-W26',
    });
  });

  it('derives a different dedupKey when facet is present', async () => {
    mockGenerateWithTools.mockResolvedValue([toolCall(validInput({ facet: 'accelerating' }))]);

    const result = await generateProposals(insights, DATASET_ID, null, NOW);

    expect(result[0]!.dedupKey).toBe('trend:sales:accelerating');
  });

  it('returns two validated proposals for two genuine findings', async () => {
    mockGenerateWithTools.mockResolvedValue([
      toolCall(validInput({ title: 'Sales trending up' })),
      toolCall(
        validInput({
          title: 'Marketing concentration risk',
          evidence: [breakdownId],
          subject: 'marketing',
        }),
      ),
    ]);

    const result = await generateProposals(insights, DATASET_ID, null, NOW);

    expect(result).toHaveLength(2);
    expect(result.map((p) => p.title)).toEqual(['Sales trending up', 'Marketing concentration risk']);
  });

  it('drops a call that fails schema validation but keeps other valid calls', async () => {
    mockGenerateWithTools.mockResolvedValue([
      toolCall(validInput({ title: 'Good finding' })),
      toolCall(validInput({ confidence: 4.2, title: 'Bad confidence' })),
    ]);

    const result = await generateProposals(insights, DATASET_ID, null, NOW);

    expect(result).toHaveLength(1);
    expect(result[0]!.title).toBe('Good finding');
  });

  it('drops a call whose evidence cites a stat ID outside the allowed set', async () => {
    mockGenerateWithTools.mockResolvedValue([
      toolCall(validInput({ title: 'Good finding' })),
      toolCall(validInput({ title: 'Out of scope', evidence: ['not-a-real-stat-id'] })),
    ]);

    const result = await generateProposals(insights, DATASET_ID, null, NOW);

    expect(result).toHaveLength(1);
    expect(result[0]!.title).toBe('Good finding');
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ outOfScope: ['not-a-real-stat-id'] }),
      expect.any(String),
    );
  });

  it('drops a call missing a subject and logs it, without touching other calls', async () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { subject, ...noSubject } = validInput({ title: 'No subject' });

    mockGenerateWithTools.mockResolvedValue([toolCall(validInput({ title: 'Good' })), toolCall(noSubject)]);

    const result = await generateProposals(insights, DATASET_ID, null, NOW);

    expect(result).toHaveLength(1);
    expect(result[0]!.title).toBe('Good');
    expect(logger.warn).toHaveBeenCalledWith(expect.anything(), 'record_proposal call missing a subject for dedup');
  });

  it('drops a call whose input is not an object', async () => {
    mockGenerateWithTools.mockResolvedValue([
      toolCall(validInput({ title: 'Good' })),
      { name: 'record_proposal', input: 'oops' },
    ]);

    const result = await generateProposals(insights, DATASET_ID, null, NOW);

    expect(result).toHaveLength(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ input: '"oops"' }),
      'record_proposal call had a non-object input',
    );
  });

  it('drops a call whose facet is not a string', async () => {
    mockGenerateWithTools.mockResolvedValue([toolCall(validInput({ facet: 42 }))]);

    const result = await generateProposals(insights, DATASET_ID, null, NOW);

    expect(result).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(expect.anything(), 'record_proposal call had a non-string facet');
  });

  it('treats a null facet the same as an omitted facet', async () => {
    mockGenerateWithTools.mockResolvedValue([toolCall(validInput({ facet: null }))]);

    const result = await generateProposals(insights, DATASET_ID, null, NOW);

    expect(result).toHaveLength(1);
    expect(result[0]!.dedupKey).toBe('trend:sales:default');
  });

  it('trims whitespace around an evidence id before checking it against the allowed set', async () => {
    mockGenerateWithTools.mockResolvedValue([toolCall(validInput({ evidence: [`  ${trendId}  `] }))]);

    const result = await generateProposals(insights, DATASET_ID, null, NOW);

    expect(result).toHaveLength(1);
    expect(result[0]!.evidence).toEqual([trendId]);
  });

  it('treats a whitespace-only subject as missing', async () => {
    mockGenerateWithTools.mockResolvedValue([toolCall(validInput({ subject: '   ' }))]);

    const result = await generateProposals(insights, DATASET_ID, null, NOW);

    expect(result).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(expect.anything(), 'record_proposal call missing a subject for dedup');
  });

  it('treats an empty-string facet the same as an omitted facet', async () => {
    mockGenerateWithTools.mockResolvedValue([toolCall(validInput({ facet: '' }))]);

    const result = await generateProposals(insights, DATASET_ID, null, NOW);

    expect(result[0]!.dedupKey).toBe('trend:sales:default');
  });

  it('drops a duplicate dedupKey within the same batch, keeping the first when both are equally strong', async () => {
    mockGenerateWithTools.mockResolvedValue([
      toolCall(validInput({ title: 'First mention' })),
      toolCall(validInput({ title: 'Second mention, same subject and kind' })),
    ]);

    const result = await generateProposals(insights, DATASET_ID, null, NOW);

    expect(result).toHaveLength(1);
    expect(result[0]!.title).toBe('First mention');
  });

  it('keeps the higher-severity call on a duplicate dedupKey, even when it comes second', async () => {
    mockGenerateWithTools.mockResolvedValue([
      toolCall(validInput({ title: 'Weak first guess', severity: 'notice' })),
      toolCall(validInput({ title: 'Stronger correction', severity: 'critical' })),
    ]);

    const result = await generateProposals(insights, DATASET_ID, null, NOW);

    expect(result).toHaveLength(1);
    expect(result[0]!.title).toBe('Stronger correction');
  });

  it('treats subjects differing only by surrounding whitespace as the same dedup identity', async () => {
    mockGenerateWithTools.mockResolvedValue([
      toolCall(validInput({ title: 'First mention', subject: ' sales ' })),
      toolCall(validInput({ title: 'Second mention, padded subject', subject: 'sales' })),
    ]);

    const result = await generateProposals(insights, DATASET_ID, null, NOW);

    expect(result).toHaveLength(1);
  });

  it('keeps a valid action payload on the resulting proposal', async () => {
    mockGenerateWithTools.mockResolvedValue([
      toolCall(
        validInput({
          action: { type: 'flagInvoice', targetRef: 'invoice-42', estimatedImpact: { amount: 500, currency: 'USD' } },
        }),
      ),
    ]);

    const result = await generateProposals(insights, DATASET_ID, null, NOW);

    expect(result).toHaveLength(1);
    expect(result[0]!.action).toEqual({
      type: 'flagInvoice',
      targetRef: 'invoice-42',
      estimatedImpact: { amount: 500, currency: 'USD' },
    });
  });

  it('derives the correct ISO week across a year boundary', async () => {
    mockGenerateWithTools.mockResolvedValue([toolCall(validInput())]);

    const newYearsEve = await generateProposals(insights, DATASET_ID, null, new Date('2025-12-31T12:00:00Z'));
    const newYearsDay = await generateProposals(insights, DATASET_ID, null, new Date('2026-01-01T12:00:00Z'));

    expect(newYearsEve[0]!.period).toBe('2026-W01');
    expect(newYearsDay[0]!.period).toBe('2026-W01');
  });

  it('caps output at 5, keeping the highest severity then confidence', async () => {
    const severities = ['info', 'notice', 'warning', 'critical', 'info', 'critical'] as const;
    mockGenerateWithTools.mockResolvedValue(
      severities.map((severity, i) =>
        toolCall(
          validInput({
            title: `Finding ${i}`,
            subject: `subject-${i}`,
            severity,
            confidence: severity === 'critical' && i === 5 ? 0.95 : 0.7,
          }),
        ),
      ),
    );

    const result = await generateProposals(insights, DATASET_ID, null, NOW);

    expect(result).toHaveLength(5);
    expect(result.map((p) => p.severity)).toEqual(['critical', 'critical', 'warning', 'notice', 'info']);
    expect(result[0]!.title).toBe('Finding 5');
  });

  it('ignores a call to an unrecognized tool name', async () => {
    mockGenerateWithTools.mockResolvedValue([{ name: 'some_other_tool', input: validInput() }]);

    const result = await generateProposals(insights, DATASET_ID, null, NOW);

    expect(result).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: 'some_other_tool' }),
      'agent called an unrecognized tool',
    );
  });

  it('propagates errors from generateWithTools, e.g. a cost budget rejection', async () => {
    mockGenerateWithTools.mockRejectedValue(new Error('exceeded safety cap'));

    await expect(generateProposals(insights, DATASET_ID, null, NOW)).rejects.toThrow('exceeded safety cap');
  });
});
