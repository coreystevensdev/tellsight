import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGetActiveTier = vi.fn();
const mockGetActiveDatasetId = vi.fn();
const mockFindOrgById = vi.fn();
const mockGetEnabledRules = vi.fn();
const mockGetLatestFire = vi.fn();
const mockCountRecentByOrgId = vi.fn();
const mockCreateFire = vi.fn();
const mockGetDateRange = vi.fn();
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
    countRecentByOrgId: mockCountRecentByOrgId,
    create: mockCreateFire,
  },
  dataRowsQueries: { getDateRange: mockGetDateRange },
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

const baseJobData = { orgId: 42, datasetId: 100, trigger: 'cron' as const, correlationId: 'corr-123' };

beforeEach(() => {
  vi.clearAllMocks();
  mockGetActiveTier.mockResolvedValue('pro');
  mockFindOrgById.mockResolvedValue(baseOrg);
  mockGetOrgOwnerId.mockResolvedValue(7);
  mockFindUserById.mockResolvedValue({ id: 7, email: 'owner@acme.test' });
  mockCountRecentByOrgId.mockResolvedValue(0);
  mockGetLatestFire.mockResolvedValue(null);
  mockCreateFire.mockResolvedValue({ id: 999 });
});

describe('tier and dataset gates', () => {
  it('no-ops when the org has downgraded off Pro since paging', async () => {
    mockGetActiveTier.mockResolvedValueOnce('free');

    await handleEvaluateOrgJob({ id: 'j1', data: baseJobData } as never);

    expect(mockFindOrgById).not.toHaveBeenCalled();
    expect(mockRunCurationPipeline).not.toHaveBeenCalled();
  });

  it('falls back to getActiveDatasetId when the job carries no datasetId', async () => {
    mockGetActiveDatasetId.mockResolvedValueOnce(null);

    await handleEvaluateOrgJob({
      id: 'j2',
      data: { orgId: 42, trigger: 'cron', correlationId: 'c' },
    } as never);

    expect(mockGetActiveDatasetId).toHaveBeenCalledWith(42);
    expect(mockRunCurationPipeline).not.toHaveBeenCalled();
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
    expect(mockCreateFire).toHaveBeenCalledWith(
      // threshold 6mo, runwayMonths 2 => <= 6/2 (3) but > 6/4 (1.5): band 2
      expect.objectContaining({ orgId: 42, ruleId: 1, ruleKind: 'runway_runs_short', band: 2 }),
      { __tag: 'dbAdmin' },
    );
    expect(mockSendQueueAdd).toHaveBeenCalledTimes(1);
    expect(mockSendQueueAdd.mock.calls[0]![0]).toBe('alert-send-999');
    expect(mockSendQueueAdd.mock.calls[0]![1]).toMatchObject({
      orgId: 42,
      userEmail: 'owner@acme.test',
      ruleId: 1,
      ruleKind: 'runway_runs_short',
      fireId: 999,
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

    expect(mockCreateFire).not.toHaveBeenCalled();
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

    expect(mockCreateFire).toHaveBeenCalledWith(expect.objectContaining({ band: 3 }), { __tag: 'dbAdmin' });
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

    expect(mockCreateFire).toHaveBeenCalled();
  });

  it('suppresses a 4th candidate fire once the org quota is exhausted (I/O matrix row 4)', async () => {
    mockGetEnabledRules.mockResolvedValueOnce([runwayRule()]);
    mockRunCurationPipeline.mockResolvedValueOnce([runwayInsight(2)]);
    mockCountRecentByOrgId.mockResolvedValueOnce(3);

    await handleEvaluateOrgJob({ id: 'j8', data: baseJobData } as never);

    expect(mockCreateFire).not.toHaveBeenCalled();
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
    expect(mockCreateFire).not.toHaveBeenCalled();
  });

  it('logs a fire but skips the send enqueue when the org has no owner', async () => {
    mockGetEnabledRules.mockResolvedValueOnce([runwayRule()]);
    mockRunCurationPipeline.mockResolvedValueOnce([runwayInsight(2)]);
    mockGetOrgOwnerId.mockResolvedValueOnce(null);

    await handleEvaluateOrgJob({ id: 'j10', data: baseJobData } as never);

    expect(mockCreateFire).toHaveBeenCalled();
    expect(mockSendQueueAdd).not.toHaveBeenCalled();
  });

  it('lets curation pipeline errors propagate so BullMQ retries (I/O matrix row 7)', async () => {
    mockGetEnabledRules.mockResolvedValueOnce([runwayRule()]);
    const err = new Error('connection refused');
    mockRunCurationPipeline.mockRejectedValueOnce(err);

    await expect(handleEvaluateOrgJob({ id: 'j11', data: baseJobData } as never)).rejects.toBe(err);
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

    expect(mockCreateFire).toHaveBeenCalledTimes(1);
    expect(mockCreateFire).toHaveBeenCalledWith(
      expect.objectContaining({ ruleKind: 'runway_runs_short' }),
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
    expect(mockCreateFire).not.toHaveBeenCalled();
  });

  it('exits cleanly when the org has no on-upload-eligible rules', async () => {
    mockGetEnabledRules.mockResolvedValueOnce([marginRule()]);

    await handleEvaluateOrgJob({ id: 'j14', data: uploadJobData } as never);

    expect(mockGetDateRange).not.toHaveBeenCalled();
    expect(mockRunCurationPipeline).not.toHaveBeenCalled();
  });
});
