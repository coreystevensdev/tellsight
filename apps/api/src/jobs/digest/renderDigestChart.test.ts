import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { ComputedStat, ScoredInsight } from '../../services/curation/types.js';
import { StatType } from '../../services/curation/types.js';

const mockRenderChart = vi.fn();
const mockRedisSet = vi.fn();
const mockRedisGetBuffer = vi.fn();

vi.mock('../../services/charting/renderChart.js', () => ({ renderChart: mockRenderChart }));
vi.mock('../../lib/redis.js', () => ({ redis: { set: mockRedisSet, getBuffer: mockRedisGetBuffer } }));
vi.mock('../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { renderDigestChart, readDigestChart, chartCacheKey } = await import('./renderDigestChart.js');

function scored(stat: ComputedStat, score: number): ScoredInsight {
  return { stat, score, breakdown: { novelty: 0, actionability: 0, specificity: 0 } };
}

const runway: ComputedStat = {
  statType: StatType.Runway,
  category: null,
  value: 4,
  sampleSize: 3,
  details: {
    cashOnHand: 10_000,
    monthlyNet: -2_500,
    runwayMonths: 4,
    cashAsOfDate: '2026-11-01',
    confidence: 'high',
    trailingMonths: 3,
  },
};

const margin: ComputedStat = {
  statType: StatType.MarginTrend,
  category: null,
  value: 12,
  sampleSize: 6,
  details: {
    recentMarginPercent: 12,
    priorMarginPercent: 22,
    direction: 'shrinking',
    revenueGrowthPercent: -4,
    expenseGrowthPercent: 6,
  },
};

const anomaly: ComputedStat = {
  statType: StatType.Anomaly,
  category: 'Payroll',
  value: 9_000,
  sampleSize: 12,
  details: {
    direction: 'above',
    zScore: 3.1,
    iqrBounds: { lower: 1_000, upper: 5_000 },
    deviation: 4_000,
    period: '2026-10',
  },
};

const weekStart = new Date('2026-11-15T00:00:00Z');
const base = { orgId: 42, datasetId: 100, weekStart, correlationId: 'corr-1' };

beforeEach(() => {
  vi.clearAllMocks();
  mockRenderChart.mockResolvedValue(Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
  mockRedisSet.mockResolvedValue('OK');
  mockRedisGetBuffer.mockResolvedValue(null);
});

describe('chartCacheKey', () => {
  // Story 4 reads this key, so the format is a contract between two stories
  // rather than an implementation detail of this one.
  it('is keyed on org, dataset and the week it belongs to', () => {
    expect(chartCacheKey(42, 100, weekStart)).toBe('digest:chart:42:100:1794700800000');
  });

  it('changes when the dataset changes, so a new upload cannot read a stale chart', () => {
    expect(chartCacheKey(42, 100, weekStart)).not.toBe(chartCacheKey(42, 101, weekStart));
  });
});

describe('renderDigestChart', () => {
  it('returns null and renders nothing when no stat has a chart', async () => {
    const kind = await renderDigestChart({ ...base, scoredPool: [scored(anomaly, 0.95)] });

    expect(kind).toBeNull();
    expect(mockRenderChart).not.toHaveBeenCalled();
    expect(mockRedisSet).not.toHaveBeenCalled();
  });

  it('returns null for an empty pool', async () => {
    expect(await renderDigestChart({ ...base, scoredPool: [] })).toBeNull();
  });

  // The pool carries the stat the selector picked by kind; the data has to come
  // from that same stat's details, not from whichever one happens to be first.
  it('builds the runway input from the runway stat it selected', async () => {
    await renderDigestChart({ ...base, scoredPool: [scored(margin, 0.52), scored(runway, 0.90)] });

    expect(mockRenderChart).toHaveBeenCalledWith(
      { chartKind: 'runway', data: { cashOnHand: 10_000, monthlyNet: -2_500, runwayMonths: 4 } },
      expect.objectContaining({ orgId: 42, correlationId: 'corr-1' }),
    );
  });

  it('builds the margin input when margin is the selected kind', async () => {
    await renderDigestChart({ ...base, scoredPool: [scored(margin, 0.84)] });

    expect(mockRenderChart).toHaveBeenCalledWith(
      {
        chartKind: 'margin',
        data: { recentMarginPercent: 12, priorMarginPercent: 22, direction: 'shrinking' },
      },
      expect.anything(),
    );
  });

  // CAP-3: the render happens once, here, rather than once per recipient.
  it('writes the PNG under the week key with a TTL and reports the kind', async () => {
    const kind = await renderDigestChart({ ...base, scoredPool: [scored(runway, 0.9)] });

    expect(kind).toBe('runway');
    expect(mockRedisSet).toHaveBeenCalledWith(
      'digest:chart:42:100:1794700800000',
      expect.any(Buffer),
      'EX',
      expect.any(Number),
    );
  });

  // renderChart never throws; null is how it reports every failure, and CAP-4
  // says that leaves the digest otherwise intact.
  it('writes nothing when the render degrades to null', async () => {
    mockRenderChart.mockResolvedValueOnce(null);

    const kind = await renderDigestChart({ ...base, scoredPool: [scored(runway, 0.9)] });

    expect(kind).toBeNull();
    expect(mockRedisSet).not.toHaveBeenCalled();
  });

  // lib/redis sets enableOfflineQueue false, so a set throws rather than
  // queuing when Redis is down. The weekly digest must not die for a picture.
  it('does not throw when the cache write fails', async () => {
    mockRedisSet.mockRejectedValueOnce(new Error('Redis is down'));

    await expect(
      renderDigestChart({ ...base, scoredPool: [scored(runway, 0.9)] }),
    ).resolves.toBeNull();
  });
});

describe('readDigestChart', () => {
  it('reads the buffer back from the week key', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    mockRedisGetBuffer.mockResolvedValueOnce(png);

    const got = await readDigestChart(42, 100, weekStart);

    expect(mockRedisGetBuffer).toHaveBeenCalledWith('digest:chart:42:100:1794700800000');
    expect(got).toEqual(png);
  });

  // A miss is the ordinary case, not an error: a retry hours after the write, a
  // Redis restart (AOF off, RDB snapshots only), and an org whose week had no
  // chartable stat all land here.
  it('returns null on a miss', async () => {
    mockRedisGetBuffer.mockResolvedValueOnce(null);
    expect(await readDigestChart(42, 100, weekStart)).toBeNull();
  });

  it('returns null rather than throwing when Redis is down', async () => {
    mockRedisGetBuffer.mockRejectedValueOnce(new Error('Redis is down'));
    await expect(readDigestChart(42, 100, weekStart)).resolves.toBeNull();
  });
});
