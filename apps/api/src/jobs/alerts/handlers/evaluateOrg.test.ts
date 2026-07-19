import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGetActiveTier = vi.fn();
const mockGetActiveDatasetId = vi.fn();
const mockFindOrgById = vi.fn();
const mockGetEnabledRules = vi.fn();
const mockGetLatestFire = vi.fn();
const mockCreateIfUnderQuota = vi.fn();
const mockGetDateRange = vi.fn();
const mockCountDistinctDates = vi.fn();
const mockGetMonthlyBuckets = vi.fn();
const mockGetOrgOwnerId = vi.fn();
const mockFindUserById = vi.fn();
const mockRecordEvent = vi.fn().mockResolvedValue({ id: 1 });
const mockRunCurationPipeline = vi.fn();
const mockSendQueueAdd = vi.fn().mockResolvedValue(undefined);

vi.mock('bullmq', () => ({
  Queue: class {
    constructor(public name: string, public opts: unknown) {}
  },
}));

vi.mock('../../../config.js', () => ({ env: { REDIS_URL: 'redis://localhost:6379' } }));
vi.mock('../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../lib/db.js', () => ({ dbAdmin: { __tag: 'dbAdmin' } }));
vi.mock('../../../lib/sentry.js', () => ({
  Sentry: { withScope: (cb: (scope: { setTag: () => void }) => Promise<void>) => cb({ setTag: vi.fn() }) },
}));

vi.mock('../../../db/queries/index.js', () => ({
  subscriptionsQueries: { getActiveTier: mockGetActiveTier },
  orgsQueries: { getActiveDatasetId: mockGetActiveDatasetId, findOrgById: mockFindOrgById },
  alertRulesQueries: { getEnabledByOrgIdsForEvaluation: mockGetEnabledRules },
  alertRuleFiresQueries: {
    getLatestByRuleId: mockGetLatestFire,
    createIfUnderQuota: mockCreateIfUnderQuota,
  },
  dataRowsQueries: {
    getDateRange: mockGetDateRange,
    countDistinctDates: mockCountDistinctDates,
    getMonthlyBucketsByDataset: mockGetMonthlyBuckets,
  },
  userOrgsQueries: { getOrgOwnerId: mockGetOrgOwnerId },
  usersQueries: { findUserById: mockFindUserById },
  analyticsEventsQueries: { recordEvent: mockRecordEvent },
}));

vi.mock('../../../services/curation/index.js', () => ({
  runCurationPipeline: mockRunCurationPipeline,
  StatType: {
    Total: 'total',
    Average: 'average',
    Trend: 'trend',
    Anomaly: 'anomaly',
    CategoryBreakdown: 'category_breakdown',
    YearOverYear: 'year_over_year',
    MarginTrend: 'margin_trend',
    SeasonalProjection: 'seasonal_projection',
    CashFlow: 'cash_flow',
    Runway: 'runway',
    BreakEven: 'break_even',
    CashForecast: 'cash_forecast',
  },
}));

vi.mock('../queue.js', async () => {
  const actual = await vi.importActual<typeof import('../queue.js')>('../queue.js');
  return {
    ...actual,
    getSendQueue: () => ({ add: mockSendQueueAdd }),
  };
});

const { handleEvaluateOrgJob } = await import('./evaluateOrg.js');

const baseOrg = { id: 42, name: 'Acme Coffee', businessProfile: null };

function runwayRule(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 1,
    orgId: 42,
    kind: 'runway_runs_short' as const,
    threshold: { months: 6 },
    enabled: true,
    muteUntil: null,
    deletedAt: null,
    createdAt: new Date('2026-07-01'),
    updatedAt: new Date('2026-07-01'),
    ...overrides,
  };
}

function marginRule(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 2,
    orgId: 42,
    kind: 'margin_drops' as const,
    threshold: { percent: 5 },
    enabled: true,
    muteUntil: null,
    deletedAt: null,
    createdAt: new Date('2026-07-01'),
    updatedAt: new Date('2026-07-01'),
    ...overrides,
  };
}

function cashBurnRule(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 3,
    orgId: 42,
    kind: 'cash_burn_spikes' as const,
    threshold: { percent: 50 },
    enabled: true,
    muteUntil: null,
    deletedAt: null,
    createdAt: new Date('2026-07-01'),
    updatedAt: new Date('2026-07-01'),
    ...overrides,
  };
}

function breakevenRule(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 4,
    orgId: 42,
    kind: 'breakeven_gap_widens' as const,
    threshold: { percent: 50 },
    enabled: true,
    muteUntil: null,
    deletedAt: null,
    createdAt: new Date('2026-07-01'),
    updatedAt: new Date('2026-07-01'),
    ...overrides,
  };
}

function runwayInsight(runwayMonths: number) {
  return {
    stat: {
      statType: 'runway',
      category: null,
      value: runwayMonths,
      details: {
        cashOnHand: 10_000,
        monthlyNet: -5_000,
        runwayMonths,
        cashAsOfDate: '2026-07-01',
        confidence: 'high' as const,
      },
    },
    score: 0.9,
    breakdown: { novelty: 0.8, actionability: 0.9, specificity: 0.9 },
  };
}

// cash_burn_spikes reads from cashFlowForAlerting/scoreInsights running for
// real against this map (see the vi.mock block: curation/computation.js and
// curation/scoring.js are deliberately not mocked), not from an injected
// ScoredInsight like the other rule kinds get via mockRunCurationPipeline.
function monthlyBuckets(
  entries: [string, { revenue: number; expenses: number }][],
): Map<string, { revenue: number; expenses: number }> {
  return new Map(entries);
}

function breakEvenInsight(details: { breakEvenRevenue: number; gap: number }) {
  return {
    stat: {
      statType: 'break_even',
      category: null,
      value: 0,
      details: {
        monthlyFixedCosts: 10_000,
        marginPercent: 20,
        currentMonthlyRevenue: 5_000,
        confidence: 'high' as const,
        ...details,
      },
    },
    score: 0.9,
    breakdown: { novelty: 0.8, actionability: 0.9, specificity: 0.9 },
  };
}

const baseJobData = { orgId: 42, datasetId: 100, trigger: 'cron' as const, correlationId: 'corr-123' };

beforeEach(() => {
  vi.clearAllMocks();
  mockGetActiveTier.mockResolvedValue('pro');
  mockGetActiveDatasetId.mockResolvedValue(100);
  mockFindOrgById.mockResolvedValue(baseOrg);
  mockGetOrgOwnerId.mockResolvedValue(7);
  mockFindUserById.mockResolvedValue({ id: 7, email: 'owner@acme.test' });
  mockGetLatestFire.mockResolvedValue(null);
  mockCreateIfUnderQuota.mockResolvedValue({ id: 999 });
  mockCountDistinctDates.mockResolvedValue(25);
});

describe('tier and dataset gates', () => {
  it('no-ops when the org has downgraded off Pro since paging', async () => {
    mockGetActiveTier.mockResolvedValueOnce('free');

    await handleEvaluateOrgJob({ id: 'j1', data: baseJobData } as never);

    expect(mockFindOrgById).not.toHaveBeenCalled();
    expect(mockRunCurationPipeline).not.toHaveBeenCalled();
  });

  it('skips cleanly when the org has no active dataset', async () => {
    mockGetActiveDatasetId.mockResolvedValueOnce(null);

    await handleEvaluateOrgJob({
      id: 'j2',
      data: { orgId: 42, trigger: 'cron', correlationId: 'c' },
    } as never);

    expect(mockGetActiveDatasetId).toHaveBeenCalledWith(42, { __tag: 'dbAdmin' });
    expect(mockRunCurationPipeline).not.toHaveBeenCalled();
  });

  it('evaluates against the freshly-fetched dataset id, ignoring a stale job payload datasetId (I/O matrix row 8)', async () => {
    mockGetActiveDatasetId.mockResolvedValueOnce(555);
    mockGetEnabledRules.mockResolvedValueOnce([runwayRule()]);
    mockRunCurationPipeline.mockResolvedValueOnce([runwayInsight(2)]);

    await handleEvaluateOrgJob({
      id: 'j-stale-dataset',
      data: { orgId: 42, datasetId: 999, trigger: 'cron', correlationId: 'c' },
    } as never);

    expect(mockGetActiveDatasetId).toHaveBeenCalledWith(42, { __tag: 'dbAdmin' });
    expect(mockRunCurationPipeline).toHaveBeenCalledWith(42, 555, { __tag: 'dbAdmin' }, null);
  });

  it('exits cleanly when the org has no enabled rules', async () => {
    mockGetEnabledRules.mockResolvedValueOnce([]);

    await handleEvaluateOrgJob({ id: 'j3', data: baseJobData } as never);

    expect(mockRunCurationPipeline).not.toHaveBeenCalled();
  });
});

describe('cron: fire decisions', () => {
  it('fires, writes a fire row, and enqueues a send job (I/O matrix row 1)', async () => {
    mockGetEnabledRules.mockResolvedValueOnce([runwayRule()]);
    mockRunCurationPipeline.mockResolvedValueOnce([runwayInsight(2)]);

    await handleEvaluateOrgJob({ id: 'j4', data: baseJobData } as never);

    expect(mockRunCurationPipeline).toHaveBeenCalledWith(42, 100, { __tag: 'dbAdmin' }, null);
    expect(mockCreateIfUnderQuota).toHaveBeenCalledWith(
      // threshold 6mo, runwayMonths 2 => <= 6/2 (3) but > 6/4 (1.5): band 2
      expect.objectContaining({ orgId: 42, ruleId: 1, ruleKind: 'runway_runs_short', band: 2 }),
      3,
      { __tag: 'dbAdmin' },
    );
    expect(mockSendQueueAdd).toHaveBeenCalledTimes(1);
    expect(mockSendQueueAdd.mock.calls[0]![0]).toBe('alert-send-999');
    expect(mockSendQueueAdd.mock.calls[0]![1]).toMatchObject({
      orgId: 42,
      userId: 7,
      userEmail: 'owner@acme.test',
      ruleId: 1,
      ruleKind: 'runway_runs_short',
      fireId: 999,
      firedInsight: runwayInsight(2),
    });
  });

  it('suppresses a same-band re-fire within 7 days (I/O matrix row 2)', async () => {
    mockGetEnabledRules.mockResolvedValueOnce([runwayRule()]);
    mockRunCurationPipeline.mockResolvedValueOnce([runwayInsight(2)]); // band 2
    mockGetLatestFire.mockResolvedValueOnce({
      id: 50,
      band: 2,
      firedAt: new Date(Date.now() - 2 * 86_400_000),
    });

    await handleEvaluateOrgJob({ id: 'j5', data: baseJobData } as never);

    expect(mockCreateIfUnderQuota).not.toHaveBeenCalled();
    expect(mockSendQueueAdd).not.toHaveBeenCalled();
  });

  it('re-fires when the value worsens into a new band despite a recent fire (I/O matrix row 3)', async () => {
    mockGetEnabledRules.mockResolvedValueOnce([runwayRule()]);
    mockRunCurationPipeline.mockResolvedValueOnce([runwayInsight(0.8)]); // band 3
    mockGetLatestFire.mockResolvedValueOnce({
      id: 50,
      band: 1,
      firedAt: new Date(Date.now() - 2 * 86_400_000),
    });

    await handleEvaluateOrgJob({ id: 'j6', data: baseJobData } as never);

    expect(mockCreateIfUnderQuota).toHaveBeenCalledWith(
      expect.objectContaining({ band: 3 }),
      3,
      { __tag: 'dbAdmin' },
    );
  });

  it('ignores a fire older than the 7-day dedup window even with the same band', async () => {
    mockGetEnabledRules.mockResolvedValueOnce([runwayRule()]);
    mockRunCurationPipeline.mockResolvedValueOnce([runwayInsight(2)]); // band 2
    mockGetLatestFire.mockResolvedValueOnce({
      id: 50,
      band: 2,
      firedAt: new Date(Date.now() - 8 * 86_400_000),
    });

    await handleEvaluateOrgJob({ id: 'j7', data: baseJobData } as never);

    expect(mockCreateIfUnderQuota).toHaveBeenCalled();
  });

  it('suppresses a 4th candidate fire once the org quota is exhausted (I/O matrix row 4)', async () => {
    mockGetEnabledRules.mockResolvedValueOnce([runwayRule()]);
    mockRunCurationPipeline.mockResolvedValueOnce([runwayInsight(2)]);
    mockCreateIfUnderQuota.mockResolvedValueOnce(null);

    await handleEvaluateOrgJob({ id: 'j8', data: baseJobData } as never);

    expect(mockSendQueueAdd).not.toHaveBeenCalled();
    expect(mockRecordEvent).toHaveBeenCalledWith(
      42,
      null,
      'alert.quota_suppressed',
      expect.objectContaining({ ruleId: 1 }),
      { __tag: 'dbAdmin' },
    );
  });

  it('suppresses when no matching stat exists for the rule kind', async () => {
    mockGetEnabledRules.mockResolvedValueOnce([runwayRule()]);
    mockRunCurationPipeline.mockResolvedValueOnce([]);

    await handleEvaluateOrgJob({ id: 'j9', data: baseJobData } as never);

    expect(mockGetLatestFire).not.toHaveBeenCalled();
    expect(mockCreateIfUnderQuota).not.toHaveBeenCalled();
  });

  it('logs a fire but skips the send enqueue when the org has no owner', async () => {
    mockGetEnabledRules.mockResolvedValueOnce([runwayRule()]);
    mockRunCurationPipeline.mockResolvedValueOnce([runwayInsight(2)]);
    mockGetOrgOwnerId.mockResolvedValueOnce(null);

    await handleEvaluateOrgJob({ id: 'j10', data: baseJobData } as never);

    expect(mockCreateIfUnderQuota).toHaveBeenCalled();
    expect(mockSendQueueAdd).not.toHaveBeenCalled();
  });

  it('lets curation pipeline errors propagate so BullMQ retries (I/O matrix row 7)', async () => {
    mockGetEnabledRules.mockResolvedValueOnce([runwayRule()]);
    const err = new Error('connection refused');
    mockRunCurationPipeline.mockRejectedValueOnce(err);

    await expect(handleEvaluateOrgJob({ id: 'j11', data: baseJobData } as never)).rejects.toBe(err);
  });

  it('reports a maximal-change band when zero prior expenses hide a real cash burn spike', async () => {
    mockGetEnabledRules.mockResolvedValueOnce([cashBurnRule()]);
    mockRunCurationPipeline.mockResolvedValueOnce([]);
    mockGetMonthlyBuckets.mockResolvedValueOnce(
      monthlyBuckets([
        ['2026-04', { revenue: 1_000, expenses: 0 }],
        ['2026-05', { revenue: 1_000, expenses: 0 }],
        ['2026-06', { revenue: 1_000, expenses: 500 }],
      ]),
    );

    await handleEvaluateOrgJob({ id: 'j-cb-spike', data: baseJobData } as never);

    // threshold 50%, priorAvgExpenses 0, latest.expenses 500 > 0 => currentValue = 50 * 3 = 150, band 3
    expect(mockCreateIfUnderQuota).toHaveBeenCalledWith(
      expect.objectContaining({ ruleKind: 'cash_burn_spikes', band: 3, currentValue: 150 }),
      3,
      { __tag: 'dbAdmin' },
    );
  });

  it('reports no genuine change when prior and latest cash burn expenses are both zero', async () => {
    mockGetEnabledRules.mockResolvedValueOnce([cashBurnRule()]);
    mockRunCurationPipeline.mockResolvedValueOnce([]);
    mockGetMonthlyBuckets.mockResolvedValueOnce(
      monthlyBuckets([
        ['2026-04', { revenue: 1_000, expenses: 0 }],
        ['2026-05', { revenue: 1_000, expenses: 0 }],
        ['2026-06', { revenue: 1_000, expenses: 0 }],
      ]),
    );

    await handleEvaluateOrgJob({ id: 'j-cb-flat', data: baseJobData } as never);

    expect(mockCreateIfUnderQuota).not.toHaveBeenCalled();
  });

  it('fires cash_burn_spikes for a near-break-even org the dashboard would suppress (DW-7)', async () => {
    mockGetEnabledRules.mockResolvedValueOnce([cashBurnRule()]);
    mockRunCurationPipeline.mockResolvedValueOnce([]);
    // avg revenue 10,500, 5% band = 525; median net here is 500, inside the
    // band, so cashFlowFromBuckets (the dashboard path) would return [] for
    // this exact data. cashFlowForAlerting skips that guard.
    mockGetMonthlyBuckets.mockResolvedValueOnce(
      monthlyBuckets([
        ['2026-04', { revenue: 10_500, expenses: 10_000 }],
        ['2026-05', { revenue: 10_500, expenses: 10_000 }],
        ['2026-06', { revenue: 10_500, expenses: 15_000 }],
      ]),
    );

    await handleEvaluateOrgJob({ id: 'j-cb-near-break-even', data: baseJobData } as never);

    // threshold 50%, priorAvgExpenses 10,000, latest.expenses 15,000 => currentValue = 50, band 1
    expect(mockCreateIfUnderQuota).toHaveBeenCalledWith(
      expect.objectContaining({ ruleKind: 'cash_burn_spikes', band: 1, currentValue: 50 }),
      3,
      { __tag: 'dbAdmin' },
    );
  });

  it('does not fetch monthly buckets when no cash_burn_spikes rule is enabled', async () => {
    mockGetEnabledRules.mockResolvedValueOnce([runwayRule()]);
    mockRunCurationPipeline.mockResolvedValueOnce([runwayInsight(2)]);

    await handleEvaluateOrgJob({ id: 'j-cb-not-enabled', data: baseJobData } as never);

    expect(mockGetMonthlyBuckets).not.toHaveBeenCalled();
  });

  it('reports a maximal-change band when break-even revenue is zero but a real gap exists', async () => {
    mockGetEnabledRules.mockResolvedValueOnce([breakevenRule()]);
    mockRunCurationPipeline.mockResolvedValueOnce([breakEvenInsight({ breakEvenRevenue: 0, gap: 2_000 })]);

    await handleEvaluateOrgJob({ id: 'j-be-spike', data: baseJobData } as never);

    // threshold 50%, breakEvenRevenue 0, gap 2000 > 0 => currentValue = 50 * 3 = 150, band 3
    expect(mockCreateIfUnderQuota).toHaveBeenCalledWith(
      expect.objectContaining({ ruleKind: 'breakeven_gap_widens', band: 3, currentValue: 150 }),
      3,
      { __tag: 'dbAdmin' },
    );
  });

  it('reports no genuine change when break-even revenue is zero and the gap is non-positive', async () => {
    mockGetEnabledRules.mockResolvedValueOnce([breakevenRule()]);
    mockRunCurationPipeline.mockResolvedValueOnce([breakEvenInsight({ breakEvenRevenue: 0, gap: -500 })]);

    await handleEvaluateOrgJob({ id: 'j-be-flat', data: baseJobData } as never);

    expect(mockCreateIfUnderQuota).not.toHaveBeenCalled();
  });
});

describe('on-upload trigger', () => {
  const uploadJobData = { orgId: 42, datasetId: 100, trigger: 'on-upload' as const, correlationId: 'corr-up' };

  it('restricts evaluation to runway/cash-burn kinds (I/O matrix row 5)', async () => {
    mockGetEnabledRules.mockResolvedValueOnce([runwayRule(), marginRule()]);
    mockGetDateRange.mockResolvedValueOnce({
      earliest: new Date('2026-01-01'),
      latest: new Date('2026-06-01'),
    });
    mockRunCurationPipeline.mockResolvedValueOnce([runwayInsight(2)]);

    await handleEvaluateOrgJob({ id: 'j12', data: uploadJobData } as never);

    expect(mockCreateIfUnderQuota).toHaveBeenCalledTimes(1);
    expect(mockCreateIfUnderQuota).toHaveBeenCalledWith(
      expect.objectContaining({ ruleKind: 'runway_runs_short' }),
      3,
      { __tag: 'dbAdmin' },
    );
  });

  it('skips every rule when dataset history is under 30 days (I/O matrix row 6)', async () => {
    mockGetEnabledRules.mockResolvedValueOnce([runwayRule()]);
    mockGetDateRange.mockResolvedValueOnce({
      earliest: new Date('2026-06-01'),
      latest: new Date('2026-06-13'),
    });

    await handleEvaluateOrgJob({ id: 'j13', data: uploadJobData } as never);

    expect(mockRunCurationPipeline).not.toHaveBeenCalled();
    expect(mockCreateIfUnderQuota).not.toHaveBeenCalled();
  });

  it('skips every rule when the span is wide enough but the dataset touches too few distinct dates (I/O matrix row: sparse-but-wide)', async () => {
    mockGetEnabledRules.mockResolvedValueOnce([runwayRule()]);
    mockGetDateRange.mockResolvedValueOnce({
      earliest: new Date('2026-01-01'),
      latest: new Date('2026-01-31'),
    });
    mockCountDistinctDates.mockResolvedValueOnce(2);

    await handleEvaluateOrgJob({ id: 'j-sparse', data: uploadJobData } as never);

    expect(mockRunCurationPipeline).not.toHaveBeenCalled();
    expect(mockCreateIfUnderQuota).not.toHaveBeenCalled();
  });

  it('passes the density gate at exactly the distinct-day floor (boundary: 20 of a 30-day span)', async () => {
    mockGetEnabledRules.mockResolvedValueOnce([runwayRule()]);
    mockGetDateRange.mockResolvedValueOnce({
      earliest: new Date('2026-01-01'),
      latest: new Date('2026-01-31'),
    });
    mockCountDistinctDates.mockResolvedValueOnce(20);
    mockRunCurationPipeline.mockResolvedValueOnce([runwayInsight(2)]);

    await handleEvaluateOrgJob({ id: 'j-density-boundary-pass', data: uploadJobData } as never);

    expect(mockRunCurationPipeline).toHaveBeenCalled();
  });

  it('fails the density gate one day under the distinct-day floor (boundary: 19 of a 30-day span)', async () => {
    mockGetEnabledRules.mockResolvedValueOnce([runwayRule()]);
    mockGetDateRange.mockResolvedValueOnce({
      earliest: new Date('2026-01-01'),
      latest: new Date('2026-01-31'),
    });
    mockCountDistinctDates.mockResolvedValueOnce(19);

    await handleEvaluateOrgJob({ id: 'j-density-boundary-fail', data: uploadJobData } as never);

    expect(mockRunCurationPipeline).not.toHaveBeenCalled();
  });

  it('exits cleanly when the org has no on-upload-eligible rules', async () => {
    mockGetEnabledRules.mockResolvedValueOnce([marginRule()]);

    await handleEvaluateOrgJob({ id: 'j14', data: uploadJobData } as never);

    expect(mockGetDateRange).not.toHaveBeenCalled();
    expect(mockRunCurationPipeline).not.toHaveBeenCalled();
  });

  it('evaluates cash_burn_spikes via the alert-only path once the on-upload history gate passes', async () => {
    mockGetEnabledRules.mockResolvedValueOnce([cashBurnRule()]);
    mockGetDateRange.mockResolvedValueOnce({
      earliest: new Date('2026-01-01'),
      latest: new Date('2026-06-01'),
    });
    mockRunCurationPipeline.mockResolvedValueOnce([]);
    mockGetMonthlyBuckets.mockResolvedValueOnce(
      monthlyBuckets([
        ['2026-04', { revenue: 1_000, expenses: 0 }],
        ['2026-05', { revenue: 1_000, expenses: 0 }],
        ['2026-06', { revenue: 1_000, expenses: 500 }],
      ]),
    );

    await handleEvaluateOrgJob({ id: 'j-cb-on-upload', data: uploadJobData } as never);

    expect(mockGetMonthlyBuckets).toHaveBeenCalledWith(42, 100, { __tag: 'dbAdmin' });
    expect(mockCreateIfUnderQuota).toHaveBeenCalledWith(
      expect.objectContaining({ ruleKind: 'cash_burn_spikes', band: 3, currentValue: 150 }),
      3,
      { __tag: 'dbAdmin' },
    );
  });
});
