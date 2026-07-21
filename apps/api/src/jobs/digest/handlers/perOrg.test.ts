import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import type { ComputedStat } from '../../../services/curation/types.js';
import type { SendJobData } from '../queue.js';

const mockGetActiveDatasetId = vi.fn();
const mockFindOrgById = vi.fn();
const mockGetCachedDigest = vi.fn();
const mockStoreSummary = vi.fn();
const mockFindOrgRecipients = vi.fn();
const mockSendQueueAdd = vi.fn().mockResolvedValue(undefined);
const mockRunCurationPipeline = vi.fn();
const mockAssemblePrompt = vi.fn();
const mockGenerateInterpretation = vi.fn();
const mockValidateStatRefs = vi.fn();
const mockValidateCiteRefs = vi.fn();
const mockGetLastDigest = vi.fn();
const mockSaveDigestHistory = vi.fn();
const mockGetMonthlyBucketsByDataset = vi.fn();
const mockGetAwardedKinds = vi.fn();
const mockAwardMilestone = vi.fn();

vi.mock('bullmq', () => ({
  Queue: class { constructor(public name: string, public opts: unknown) {} },
}));

vi.mock('../../../config.js', () => ({ env: { REDIS_URL: 'redis://localhost:6379' } }));
vi.mock('../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
const mockTransaction = vi.fn();
// Distinct object identity (not `expect.anything()`) so tests can confirm
// saveDigestHistory and awardMilestone both received this exact tx rather
// than one of them silently falling back to the module-level dbAdmin.
const TX_MARKER = { __brand: 'tx' };

vi.mock('../../../lib/db.js', () => ({
  dbAdmin: {
    transaction: (cb: (tx: unknown) => unknown) => {
      mockTransaction(cb);
      return cb(TX_MARKER);
    },
  },
}));

vi.mock('../../../db/queries/index.js', () => ({
  aiSummariesQueries: {
    getCachedDigest: mockGetCachedDigest,
    storeSummary: mockStoreSummary,
  },
  dataRowsQueries: {
    getMonthlyBucketsByDataset: mockGetMonthlyBucketsByDataset,
  },
  digestEligibilityQueries: {
    findOrgRecipients: mockFindOrgRecipients,
  },
  digestHistoryQueries: {
    getLastDigest: mockGetLastDigest,
    saveDigestHistory: mockSaveDigestHistory,
  },
  milestoneAwardsQueries: {
    getAwardedKinds: mockGetAwardedKinds,
    awardMilestone: mockAwardMilestone,
  },
  orgsQueries: {
    getActiveDatasetId: mockGetActiveDatasetId,
    findOrgById: mockFindOrgById,
  },
}));

vi.mock('../../../services/curation/index.js', () => ({
  runCurationPipeline: mockRunCurationPipeline,
  assemblePrompt: mockAssemblePrompt,
  validateStatRefs: mockValidateStatRefs,
  stripInvalidStatRefs: (text: string) => text,
  validateCiteRefs: mockValidateCiteRefs,
  stripInvalidCiteRefs: (text: string) => text,
  transparencyMetadataSchema: { parse: (m: unknown) => m },
}));

vi.mock('../../../services/aiInterpretation/claudeClient.js', () => ({
  generateInterpretation: mockGenerateInterpretation,
}));

vi.mock('../queue.js', async () => {
  const actual = await vi.importActual<typeof import('../queue.js')>('../queue.js');
  return {
    ...actual,
    getSendQueue: () => ({ add: mockSendQueueAdd }),
  };
});

const { logger } = await import('../../../lib/logger.js');
const { handlePerOrgJob } = await import('./perOrg.js');

const baseOrg = {
  id: 42,
  name: 'Acme Coffee',
  businessProfile: null,
};

const baseJobData = {
  orgId: 42,
  weekStart: new Date('2026-05-03T00:00:00Z'),
  weekEnd: new Date('2026-05-09T23:59:59Z'),
  correlationId: 'corr-123',
};

function breakEvenStat(gap: number): ComputedStat {
  return {
    statType: 'break_even',
    category: null,
    value: gap,
    details: {
      monthlyFixedCosts: 5000,
      marginPercent: 20,
      breakEvenRevenue: 5000,
      currentMonthlyRevenue: 5000 - gap,
      gap,
      confidence: 'high',
    },
  };
}

function runwayStat(runwayMonths: number): ComputedStat {
  return {
    statType: 'runway',
    category: null,
    value: runwayMonths,
    details: {
      cashOnHand: 12000,
      monthlyNet: -2000,
      runwayMonths,
      cashAsOfDate: '2026-06-01',
      confidence: 'high',
      trailingMonths: 3,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockValidateStatRefs.mockReturnValue({ invalidRefs: [] });
  mockValidateCiteRefs.mockReturnValue({ invalidRefs: [] });
  mockAssemblePrompt.mockReturnValue({
    system: 'sys',
    user: 'user prompt',
    metadata: { promptVersion: 'v1-digest', statTypes: ['Total', 'Trend'] },
  });
  mockGetLastDigest.mockResolvedValue(undefined);
  mockSaveDigestHistory.mockResolvedValue(undefined);
  mockGetMonthlyBucketsByDataset.mockResolvedValue(new Map());
  mockGetAwardedKinds.mockResolvedValue(new Set());
  mockAwardMilestone.mockResolvedValue(undefined);
});

describe('cache miss path', () => {
  it('runs the curation pipeline and stores a digest summary', async () => {
    mockGetActiveDatasetId.mockResolvedValueOnce(100);
    mockFindOrgById.mockResolvedValueOnce(baseOrg);
    mockGetCachedDigest.mockResolvedValueOnce(undefined);
    mockRunCurationPipeline.mockResolvedValueOnce([{ stat: { statType: 'Total' } }]);
    mockGenerateInterpretation.mockResolvedValueOnce('- bullet 1\n- bullet 2\n- bullet 3');
    mockStoreSummary.mockResolvedValueOnce({ id: 999 });
    mockFindOrgRecipients.mockResolvedValueOnce([]);

    await handlePerOrgJob({ id: 'org-1', data: baseJobData } as never);

    expect(mockRunCurationPipeline).toHaveBeenCalledWith(42, 100, undefined, null);
    // No prior digest, so priorContext is '' and promptVersion stays v1-digest.
    expect(mockAssemblePrompt).toHaveBeenCalledWith(
      [{ stat: { statType: 'Total' } }],
      100,
      'v1-digest',
      null,
      expect.any(Date),
      '',
    );
    expect(mockStoreSummary).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: 42,
        datasetId: 100,
        content: '- bullet 1\n- bullet 2\n- bullet 3',
        promptVersion: 'v1-digest',
        audience: 'digest-weekly',
        weekStart: baseJobData.weekStart,
      }),
    );
  });

  it('passes the financials subset from businessProfile to the pipeline', async () => {
    const orgWithProfile = {
      ...baseOrg,
      businessProfile: {
        cashOnHand: 50000,
        cashAsOfDate: '2026-05-01',
        businessStartedDate: '2024-01-01',
        monthlyFixedCosts: 8000,
      },
    };

    mockGetActiveDatasetId.mockResolvedValueOnce(100);
    mockFindOrgById.mockResolvedValueOnce(orgWithProfile);
    mockGetCachedDigest.mockResolvedValueOnce(undefined);
    mockRunCurationPipeline.mockResolvedValueOnce([]);
    mockGenerateInterpretation.mockResolvedValueOnce('');
    mockStoreSummary.mockResolvedValueOnce({ id: 1 });
    mockFindOrgRecipients.mockResolvedValueOnce([]);

    await handlePerOrgJob({ id: 'org-2', data: baseJobData } as never);

    expect(mockRunCurationPipeline).toHaveBeenCalledWith(
      42,
      100,
      undefined,
      expect.objectContaining({
        cashOnHand: 50000,
        cashAsOfDate: '2026-05-01',
        businessStartedDate: '2024-01-01',
        monthlyFixedCosts: 8000,
      }),
    );
  });

  it('selects v2-digest and a non-empty priorContext when this week diverges from a prior digest', async () => {
    mockGetActiveDatasetId.mockResolvedValueOnce(100);
    mockFindOrgById.mockResolvedValueOnce(baseOrg);
    mockGetCachedDigest.mockResolvedValueOnce(undefined);
    mockRunCurationPipeline.mockResolvedValueOnce([
      { stat: runwayStat(4.6), score: 1, breakdown: { novelty: 1, actionability: 1, specificity: 1 } },
    ]);
    mockGetLastDigest.mockResolvedValueOnce({
      keyStats: [runwayStat(4.0)],
      stateSentence: 'Runway was holding steady.',
    });
    mockGenerateInterpretation.mockResolvedValueOnce('- runway improved');
    mockStoreSummary.mockResolvedValueOnce({ id: 2 });
    mockFindOrgRecipients.mockResolvedValueOnce([]);

    await handlePerOrgJob({ id: 'org-9', data: baseJobData } as never);

    expect(mockAssemblePrompt).toHaveBeenCalledWith(
      expect.any(Array),
      100,
      'v2-digest',
      null,
      expect.any(Date),
      expect.stringContaining('Runway moved from 4.0 to 4.6 months.'),
    );
    expect(mockStoreSummary).toHaveBeenCalledWith(
      expect.objectContaining({ promptVersion: 'v2-digest' }),
    );
  });

  it('stays on v1-digest when a prior digest exists but the diff produces no deltas or milestones', async () => {
    mockGetActiveDatasetId.mockResolvedValueOnce(100);
    mockFindOrgById.mockResolvedValueOnce(baseOrg);
    mockGetCachedDigest.mockResolvedValueOnce(undefined);
    mockRunCurationPipeline.mockResolvedValueOnce([
      { stat: runwayStat(4.05), score: 1, breakdown: { novelty: 1, actionability: 1, specificity: 1 } },
    ]);
    mockGetLastDigest.mockResolvedValueOnce({
      keyStats: [runwayStat(4.0)],
      stateSentence: 'Runway was holding steady.',
    });
    mockGenerateInterpretation.mockResolvedValueOnce('- steady week');
    mockStoreSummary.mockResolvedValueOnce({ id: 3 });
    mockFindOrgRecipients.mockResolvedValueOnce([]);

    await handlePerOrgJob({ id: 'org-10', data: baseJobData } as never);

    expect(mockAssemblePrompt).toHaveBeenCalledWith(
      expect.any(Array),
      100,
      'v1-digest',
      null,
      expect.any(Date),
      '',
    );
  });
});

describe('cache hit path', () => {
  it('still runs the curation pipeline for currentStats but skips the LLM call', async () => {
    mockGetActiveDatasetId.mockResolvedValueOnce(100);
    mockFindOrgById.mockResolvedValueOnce(baseOrg);
    mockRunCurationPipeline.mockResolvedValueOnce([{ stat: { statType: 'Total' } }]);
    mockGetCachedDigest.mockResolvedValueOnce({
      id: 555,
      content: 'cached',
      transparencyMetadata: { statTypes: ['Total', 'Trend'] },
    });
    mockFindOrgRecipients.mockResolvedValueOnce([]);

    await handlePerOrgJob({ id: 'org-3', data: baseJobData } as never);

    expect(mockRunCurationPipeline).toHaveBeenCalledOnce();
    expect(mockGenerateInterpretation).not.toHaveBeenCalled();
    expect(mockStoreSummary).not.toHaveBeenCalled();
  });
});

describe('fan-out', () => {
  it('enqueues one digest-send job per recipient with summaryId only', async () => {
    mockGetActiveDatasetId.mockResolvedValueOnce(100);
    mockFindOrgById.mockResolvedValueOnce(baseOrg);
    mockRunCurationPipeline.mockResolvedValueOnce([]);
    mockGetCachedDigest.mockResolvedValueOnce({
      id: 555,
      content: 'cached',
      transparencyMetadata: {},
    });
    mockFindOrgRecipients.mockResolvedValueOnce([
      { userId: 1, email: 'a@x.com', name: 'Alice' },
      { userId: 2, email: 'b@x.com', name: 'Bob' },
    ]);

    await handlePerOrgJob({ id: 'org-4', data: baseJobData } as never);

    expect(mockSendQueueAdd).toHaveBeenCalledTimes(2);
    const firstCall = mockSendQueueAdd.mock.calls[0]!;
    const firstPayload = firstCall[1] as Record<string, unknown>;
    expect(firstPayload).toMatchObject({
      userId: 1,
      orgId: 42,
      summaryId: 555,
      userEmail: 'a@x.com',
      orgName: 'Acme Coffee',
      correlationId: 'corr-123',
    });

    // Privacy boundary: payload must NOT contain the summary content.
    expect(JSON.stringify(firstPayload)).not.toContain('cached');

    // jobId, not name, is what BullMQ actually dedupes on; a retried
    // per-org attempt must reuse the same jobId per user per week.
    const opts = firstCall[2] as { jobId: string };
    expect(opts.jobId).toBe(firstCall[0]);
    expect(opts.jobId).toMatch(/^digest-send-1-\d+$/);
  });

  it('continues fan-out when one enqueue throws (AC #4 isolation)', async () => {
    mockGetActiveDatasetId.mockResolvedValueOnce(100);
    mockFindOrgById.mockResolvedValueOnce(baseOrg);
    mockRunCurationPipeline.mockResolvedValueOnce([]);
    mockGetCachedDigest.mockResolvedValueOnce({ id: 555, content: '', transparencyMetadata: {} });
    mockFindOrgRecipients.mockResolvedValueOnce([
      { userId: 1, email: 'a@x.com', name: 'A' },
      { userId: 2, email: 'b@x.com', name: 'B' },
      { userId: 3, email: 'c@x.com', name: 'C' },
    ]);
    mockSendQueueAdd
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('Redis blip'))
      .mockResolvedValueOnce(undefined);

    await expect(handlePerOrgJob({ id: 'org-5', data: baseJobData } as never)).resolves.toBeUndefined();

    expect(mockSendQueueAdd).toHaveBeenCalledTimes(3);
  });
});

describe('digest history', () => {
  it('saves history once after fan-out with this week\'s valence, state sentence, key stats, and milestones', async () => {
    mockGetActiveDatasetId.mockResolvedValueOnce(100);
    mockFindOrgById.mockResolvedValueOnce(baseOrg);
    mockGetCachedDigest.mockResolvedValueOnce(undefined);
    mockRunCurationPipeline.mockResolvedValueOnce([
      { stat: runwayStat(2.8), score: 1, breakdown: { novelty: 1, actionability: 1, specificity: 1 } },
    ]);
    mockGetLastDigest.mockResolvedValueOnce({
      keyStats: [runwayStat(3.5)],
      stateSentence: 'Runway was comfortable.',
    });
    mockGenerateInterpretation.mockResolvedValueOnce('- Runway dropped\n- second bullet');
    mockStoreSummary.mockResolvedValueOnce({ id: 4 });
    mockFindOrgRecipients.mockResolvedValueOnce([{ userId: 1, email: 'a@x.com', name: 'A' }]);

    await handlePerOrgJob({ id: 'org-11', data: baseJobData } as never);

    // Milestone phrase, not the valence-only fallback, proves subjectLine is
    // actually threaded through rather than coincidentally present.
    const expectedSubject = 'Your runway needs attention - Acme Coffee weekly insights';

    expect(mockSendQueueAdd).toHaveBeenCalledOnce();
    const sendPayload = mockSendQueueAdd.mock.calls[0]![1] as SendJobData;
    expect(sendPayload.subjectLine).toBe(expectedSubject);

    expect(mockSaveDigestHistory).toHaveBeenCalledOnce();
    expect(mockSaveDigestHistory).toHaveBeenCalledWith(
      {
        orgId: 42,
        datasetId: 100,
        summaryId: 4,
        weekStart: baseJobData.weekStart,
        subjectLine: expectedSubject,
        stateSentence: 'Runway dropped',
        valence: 'concerning',
        keyStats: [runwayStat(2.8)],
        milestones: [
          {
            kind: 'runway_dropped_below_3mo',
            label: 'Your runway dropped below 3 months.',
            catalog: 'transition',
          },
        ],
        sentAt: expect.any(Date),
      },
      expect.anything(), // tx
    );
  });

  it('strips the leading bullet marker from a cached digest to build the state sentence', async () => {
    mockGetActiveDatasetId.mockResolvedValueOnce(100);
    mockFindOrgById.mockResolvedValueOnce(baseOrg);
    mockRunCurationPipeline.mockResolvedValueOnce([]);
    mockGetCachedDigest.mockResolvedValueOnce({
      id: 555,
      content: '\n  - Revenue held flat this week.\n- second bullet',
      transparencyMetadata: {},
    });
    mockFindOrgRecipients.mockResolvedValueOnce([]);

    await handlePerOrgJob({ id: 'org-12', data: baseJobData } as never);

    expect(mockSaveDigestHistory).toHaveBeenCalledWith(
      expect.objectContaining({ stateSentence: 'Revenue held flat this week.' }),
      expect.anything(),
    );
  });

  it('logs and continues when saveDigestHistory throws, without failing the job or blocking sends', async () => {
    mockGetActiveDatasetId.mockResolvedValueOnce(100);
    mockFindOrgById.mockResolvedValueOnce(baseOrg);
    mockRunCurationPipeline.mockResolvedValueOnce([]);
    mockGetCachedDigest.mockResolvedValueOnce({ id: 555, content: 'cached', transparencyMetadata: {} });
    mockFindOrgRecipients.mockResolvedValueOnce([{ userId: 1, email: 'a@x.com', name: 'A' }]);
    mockSaveDigestHistory.mockRejectedValueOnce(new Error('unique violation'));

    await expect(handlePerOrgJob({ id: 'org-13', data: baseJobData } as never)).resolves.toBeUndefined();

    expect(mockSendQueueAdd).toHaveBeenCalledOnce();
    expect(mockTransaction).toHaveBeenCalledOnce();
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: 42 }),
      'Failed to save digest history and award milestones, continuing',
    );
  });

  it('still saves history after a partial fan-out failure (isolated from enqueue errors)', async () => {
    mockGetActiveDatasetId.mockResolvedValueOnce(100);
    mockFindOrgById.mockResolvedValueOnce(baseOrg);
    mockRunCurationPipeline.mockResolvedValueOnce([]);
    mockGetCachedDigest.mockResolvedValueOnce({ id: 555, content: 'cached', transparencyMetadata: {} });
    mockFindOrgRecipients.mockResolvedValueOnce([
      { userId: 1, email: 'a@x.com', name: 'A' },
      { userId: 2, email: 'b@x.com', name: 'B' },
    ]);
    mockSendQueueAdd
      .mockRejectedValueOnce(new Error('Redis blip'))
      .mockResolvedValueOnce(undefined);

    await handlePerOrgJob({ id: 'org-14', data: baseJobData } as never);

    expect(mockSendQueueAdd).toHaveBeenCalledTimes(2);
    expect(mockSaveDigestHistory).toHaveBeenCalledOnce();
  });
});

describe('prior-digest lookup', () => {
  it('excludes the current run\'s own week by passing weekStart to getLastDigest', async () => {
    mockGetActiveDatasetId.mockResolvedValueOnce(100);
    mockFindOrgById.mockResolvedValueOnce(baseOrg);
    mockGetCachedDigest.mockResolvedValueOnce(undefined);
    mockRunCurationPipeline.mockResolvedValueOnce([]);
    mockGenerateInterpretation.mockResolvedValueOnce('- steady week');
    mockStoreSummary.mockResolvedValueOnce({ id: 20 });
    mockFindOrgRecipients.mockResolvedValueOnce([]);

    await handlePerOrgJob({ id: 'org-19', data: baseJobData } as never);

    expect(mockGetLastDigest).toHaveBeenCalledWith(42, baseJobData.weekStart);
  });

  it('falls back to empty prior context when the prior row has a malformed stat, but still sends and saves history', async () => {
    mockGetActiveDatasetId.mockResolvedValueOnce(100);
    mockFindOrgById.mockResolvedValueOnce(baseOrg);
    mockGetCachedDigest.mockResolvedValueOnce(undefined);
    mockRunCurationPipeline.mockResolvedValueOnce([
      { stat: runwayStat(4.6), score: 1, breakdown: { novelty: 1, actionability: 1, specificity: 1 } },
    ]);
    // `runway` statType matches, but `details` is missing -- buildPriorContext
    // dereferences `.details.runwayMonths` on it and throws.
    mockGetLastDigest.mockResolvedValueOnce({
      keyStats: [{ statType: 'runway', category: null, value: 4.0 }],
      stateSentence: 'Runway was holding steady.',
    });
    mockGenerateInterpretation.mockResolvedValueOnce('- runway update');
    mockStoreSummary.mockResolvedValueOnce({ id: 21 });
    mockFindOrgRecipients.mockResolvedValueOnce([{ userId: 1, email: 'a@x.com', name: 'A' }]);

    await expect(handlePerOrgJob({ id: 'org-20', data: baseJobData } as never)).resolves.toBeUndefined();

    expect(mockSendQueueAdd).toHaveBeenCalledOnce();
    expect(mockSaveDigestHistory).toHaveBeenCalledOnce();
    expect(mockSaveDigestHistory).toHaveBeenCalledWith(
      expect.objectContaining({ keyStats: [runwayStat(4.6)] }),
      expect.anything(),
    );
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: 42, weekStart: baseJobData.weekStart }),
      'Failed to derive prior-digest context, continuing with no prior context',
    );

    // v1-digest, not v2, since the guard's empty-array fallback produces no
    // priorContext, same as the "no prior digest" path.
    expect(mockAssemblePrompt).toHaveBeenCalledWith(
      expect.any(Array),
      100,
      'v1-digest',
      null,
      expect.any(Date),
      '',
    );
  });
});

describe('first-time milestones', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 5, 15, 12, 0, 0));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fetches monthly buckets and awarded kinds, threads a fired first-time milestone into history, the subject line, and awards it after enqueue', async () => {
    mockGetActiveDatasetId.mockResolvedValueOnce(100);
    mockFindOrgById.mockResolvedValueOnce(baseOrg);
    mockGetCachedDigest.mockResolvedValueOnce(undefined);
    mockRunCurationPipeline.mockResolvedValueOnce([]);
    mockGetMonthlyBucketsByDataset.mockResolvedValueOnce(
      new Map([
        ['2026-04', { revenue: 4000, expenses: 5000 }],
        ['2026-05', { revenue: 6000, expenses: 5000 }],
      ]),
    );
    mockGetAwardedKinds.mockResolvedValueOnce(new Set());
    mockGenerateInterpretation.mockResolvedValueOnce('- steady week');
    mockStoreSummary.mockResolvedValueOnce({ id: 5 });
    mockFindOrgRecipients.mockResolvedValueOnce([{ userId: 1, email: 'a@x.com', name: 'A' }]);

    await handlePerOrgJob({ id: 'org-15', data: baseJobData } as never);

    expect(mockGetMonthlyBucketsByDataset).toHaveBeenCalledWith(42, 100, expect.anything());
    expect(mockGetAwardedKinds).toHaveBeenCalledWith(42);

    const sendPayload = mockSendQueueAdd.mock.calls[0]![1] as SendJobData;
    expect(sendPayload.subjectLine).toBe("You've hit your first profitable month - Acme Coffee weekly insights");

    expect(mockSaveDigestHistory).toHaveBeenCalledWith(
      expect.objectContaining({
        milestones: [
          {
            kind: 'first_profitable_month',
            label: 'This is your first profitable month.',
            catalog: 'first_time',
          },
        ],
      }),
      TX_MARKER,
    );

    // Exact tx identity, not expect.anything(): catches a copy-paste slip
    // where one call falls back to dbAdmin instead of the shared tx.
    expect(mockAwardMilestone).toHaveBeenCalledWith(
      { orgId: 42, kind: 'first_profitable_month', datasetId: 100 },
      TX_MARKER,
    );
    expect(mockTransaction).toHaveBeenCalledOnce();
    expect(mockSaveDigestHistory.mock.invocationCallOrder[0]!).toBeLessThan(
      mockAwardMilestone.mock.invocationCallOrder[0]!,
    );
  });

  it('does not re-fire a kind already present in awardedKinds', async () => {
    mockGetActiveDatasetId.mockResolvedValueOnce(100);
    mockFindOrgById.mockResolvedValueOnce(baseOrg);
    mockGetCachedDigest.mockResolvedValueOnce(undefined);
    mockRunCurationPipeline.mockResolvedValueOnce([]);
    mockGetMonthlyBucketsByDataset.mockResolvedValueOnce(
      new Map([
        ['2026-04', { revenue: 4000, expenses: 5000 }],
        ['2026-05', { revenue: 6000, expenses: 5000 }],
      ]),
    );
    mockGetAwardedKinds.mockResolvedValueOnce(new Set(['first_profitable_month']));
    mockGenerateInterpretation.mockResolvedValueOnce('- steady week');
    mockStoreSummary.mockResolvedValueOnce({ id: 6 });
    mockFindOrgRecipients.mockResolvedValueOnce([]);

    await handlePerOrgJob({ id: 'org-16', data: baseJobData } as never);

    expect(mockSaveDigestHistory).toHaveBeenCalledWith(
      expect.objectContaining({ milestones: [] }),
      expect.anything(),
    );
    expect(mockAwardMilestone).not.toHaveBeenCalled();
  });

  it('dedupes crossed_break_even out of history and subject when first_break_even fires the same week', async () => {
    const orgWithFixedCosts = {
      ...baseOrg,
      businessProfile: {
        cashOnHand: 20000,
        cashAsOfDate: '2026-06-01',
        businessStartedDate: '2024-01-01',
        monthlyFixedCosts: 5000,
      },
    };

    mockGetActiveDatasetId.mockResolvedValueOnce(100);
    mockFindOrgById.mockResolvedValueOnce(orgWithFixedCosts);
    mockGetCachedDigest.mockResolvedValueOnce(undefined);
    mockRunCurationPipeline.mockResolvedValueOnce([
      { stat: breakEvenStat(-1000), score: 1, breakdown: { novelty: 1, actionability: 1, specificity: 1 } },
    ]);
    mockGetLastDigest.mockResolvedValueOnce({
      keyStats: [breakEvenStat(500)],
      stateSentence: 'Revenue was below fixed costs.',
    });
    mockGetMonthlyBucketsByDataset.mockResolvedValueOnce(
      new Map([
        ['2026-04', { revenue: 4000, expenses: 1000 }],
        ['2026-05', { revenue: 6000, expenses: 1000 }],
      ]),
    );
    mockGetAwardedKinds.mockResolvedValueOnce(new Set());
    mockGenerateInterpretation.mockResolvedValueOnce('- revenue covered fixed costs');
    mockStoreSummary.mockResolvedValueOnce({ id: 7 });
    mockFindOrgRecipients.mockResolvedValueOnce([]);

    await handlePerOrgJob({ id: 'org-17', data: baseJobData } as never);

    expect(mockSaveDigestHistory).toHaveBeenCalledWith(
      expect.objectContaining({
        milestones: [
          {
            kind: 'first_break_even',
            label: 'For the first time, revenue covered your fixed costs.',
            catalog: 'first_time',
          },
        ],
      }),
      expect.anything(),
    );
  });

  it('logs and continues when the award write fails, without failing the job', async () => {
    mockGetActiveDatasetId.mockResolvedValueOnce(100);
    mockFindOrgById.mockResolvedValueOnce(baseOrg);
    mockGetCachedDigest.mockResolvedValueOnce(undefined);
    mockRunCurationPipeline.mockResolvedValueOnce([]);
    mockGetMonthlyBucketsByDataset.mockResolvedValueOnce(
      new Map([
        ['2026-04', { revenue: 4000, expenses: 5000 }],
        ['2026-05', { revenue: 6000, expenses: 5000 }],
      ]),
    );
    mockGetAwardedKinds.mockResolvedValueOnce(new Set());
    mockGenerateInterpretation.mockResolvedValueOnce('- steady week');
    mockStoreSummary.mockResolvedValueOnce({ id: 8 });
    mockFindOrgRecipients.mockResolvedValueOnce([]);
    mockAwardMilestone.mockRejectedValueOnce(new Error('unique violation'));

    await expect(handlePerOrgJob({ id: 'org-18', data: baseJobData } as never)).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: 42 }),
      'Failed to save digest history and award milestones, continuing',
    );
  });

  it('rolls back and resolves without throwing when saveDigestHistory succeeds but awardMilestone rejects', async () => {
    mockGetActiveDatasetId.mockResolvedValueOnce(100);
    mockFindOrgById.mockResolvedValueOnce(baseOrg);
    mockGetCachedDigest.mockResolvedValueOnce(undefined);
    mockRunCurationPipeline.mockResolvedValueOnce([]);
    mockGetMonthlyBucketsByDataset.mockResolvedValueOnce(
      new Map([
        ['2026-04', { revenue: 4000, expenses: 5000 }],
        ['2026-05', { revenue: 6000, expenses: 5000 }],
      ]),
    );
    mockGetAwardedKinds.mockResolvedValueOnce(new Set());
    mockGenerateInterpretation.mockResolvedValueOnce('- steady week');
    mockStoreSummary.mockResolvedValueOnce({ id: 9 });
    mockFindOrgRecipients.mockResolvedValueOnce([{ userId: 1, email: 'a@x.com', name: 'A' }]);
    mockAwardMilestone.mockRejectedValueOnce(new Error('connection reset'));

    await expect(handlePerOrgJob({ id: 'org-21', data: baseJobData } as never)).resolves.toBeUndefined();

    // Send jobs are enqueued before the transaction, so they aren't affected
    // by the award write rolling the history write back with it.
    expect(mockSendQueueAdd).toHaveBeenCalledOnce();
    expect(mockSaveDigestHistory).toHaveBeenCalledOnce();
    expect(mockTransaction).toHaveBeenCalledOnce();
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: 42 }),
      'Failed to save digest history and award milestones, continuing',
    );
  });

  it('rolls back an already-succeeded award in the same batch when a later milestone in the loop fails', async () => {
    // A single completed month that is both this org's first-ever profitable
    // month and the first month revenue covered fixed costs fires two
    // first-time milestones at once, exercising the loop's multi-iteration path.
    const orgWithFixedCosts = {
      ...baseOrg,
      businessProfile: {
        cashOnHand: 20000,
        cashAsOfDate: '2026-06-01',
        businessStartedDate: '2024-01-01',
        monthlyFixedCosts: 5000,
      },
    };

    mockGetActiveDatasetId.mockResolvedValueOnce(100);
    mockFindOrgById.mockResolvedValueOnce(orgWithFixedCosts);
    mockGetCachedDigest.mockResolvedValueOnce(undefined);
    mockRunCurationPipeline.mockResolvedValueOnce([]);
    mockGetMonthlyBucketsByDataset.mockResolvedValueOnce(
      new Map([['2026-05', { revenue: 6000, expenses: 1000 }]]),
    );
    mockGetAwardedKinds.mockResolvedValueOnce(new Set());
    mockGenerateInterpretation.mockResolvedValueOnce('- steady week');
    mockStoreSummary.mockResolvedValueOnce({ id: 10 });
    mockFindOrgRecipients.mockResolvedValueOnce([]);
    mockAwardMilestone.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('connection reset'));

    await expect(handlePerOrgJob({ id: 'org-22', data: baseJobData } as never)).resolves.toBeUndefined();

    expect(mockAwardMilestone).toHaveBeenCalledTimes(2);
    expect(mockAwardMilestone).toHaveBeenNthCalledWith(
      1,
      { orgId: 42, kind: 'first_profitable_month', datasetId: 100 },
      TX_MARKER,
    );
    expect(mockAwardMilestone).toHaveBeenNthCalledWith(
      2,
      { orgId: 42, kind: 'first_break_even', datasetId: 100 },
      TX_MARKER,
    );
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: 42,
        milestoneKinds: ['first_profitable_month', 'first_break_even'],
      }),
      'Failed to save digest history and award milestones, continuing',
    );
  });
});

describe('defensive paths', () => {
  it('exits cleanly when org has no active dataset', async () => {
    mockGetActiveDatasetId.mockResolvedValueOnce(null);

    await handlePerOrgJob({ id: 'org-6', data: baseJobData } as never);

    expect(mockFindOrgById).not.toHaveBeenCalled();
    expect(mockSendQueueAdd).not.toHaveBeenCalled();
  });

  it('exits cleanly when the org row is missing', async () => {
    mockGetActiveDatasetId.mockResolvedValueOnce(100);
    mockFindOrgById.mockResolvedValueOnce(undefined);

    await handlePerOrgJob({ id: 'org-7', data: baseJobData } as never);

    expect(mockGetCachedDigest).not.toHaveBeenCalled();
    expect(mockSendQueueAdd).not.toHaveBeenCalled();
  });

  it('lets DB errors during pipeline propagate so BullMQ retries', async () => {
    mockGetActiveDatasetId.mockResolvedValueOnce(100);
    mockFindOrgById.mockResolvedValueOnce(baseOrg);
    const err = new Error('connection refused');
    mockRunCurationPipeline.mockRejectedValueOnce(err);

    await expect(handlePerOrgJob({ id: 'org-8', data: baseJobData } as never)).rejects.toBe(err);
  });
});

describe('invalid job payload', () => {
  it('skips and logs a warning when orgId is missing', async () => {
    const { weekStart, weekEnd, correlationId } = baseJobData;

    await handlePerOrgJob({ id: 'org-bad-1', data: { weekStart, weekEnd, correlationId } } as never);

    expect(mockGetActiveDatasetId).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ correlationId: 'corr-123', jobId: 'org-bad-1' }),
      'invalid job payload, skipping',
    );
  });

  it('skips and logs a warning when orgId is the wrong type', async () => {
    const data = { ...baseJobData, orgId: '42' };

    await handlePerOrgJob({ id: 'org-bad-2', data } as never);

    expect(mockGetActiveDatasetId).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ correlationId: 'corr-123', jobId: 'org-bad-2' }),
      'invalid job payload, skipping',
    );
  });
});
