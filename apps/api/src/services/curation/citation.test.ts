import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGetRowsByDataset = vi.fn();
const mockGetBusinessProfile = vi.fn();
vi.mock('../../db/queries/index.js', () => ({
  dataRowsQueries: {
    getRowsByDataset: (...args: unknown[]) => mockGetRowsByDataset(...args),
  },
  orgsQueries: {
    getBusinessProfile: (...args: unknown[]) => mockGetBusinessProfile(...args),
  },
}));

vi.mock('../../lib/rls.js', () => ({
  withRlsContext: vi.fn((_orgId: number, _isAdmin: boolean, fn: (tx: unknown) => Promise<unknown>) => fn({})),
}));

vi.mock('../../lib/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

import { fetchAndResolveStat, resolveCitation } from './citation.js';
import { computeStats, assignIds } from './computation.js';
import { buildStatDetail } from './statDetail.js';
import { logger } from '../../lib/logger.js';
import { StatType } from './types.js';
import type { IdentifiedStat } from './types.js';

const ORG_ID = 1;
const DATASET_ID = 7;

// Revenue/COGS across 2025 (flat) and 2026 (step-up, then a 3-month burn in
// Oct-Dec), the same shape statDetail.test.ts uses to trigger CashFlow/Runway
// through the real computeStats/assignIds pipeline rather than a hand-built stat.
let _rowId = 1;
function row(category: string, parentCategory: string | null, date: Date, amount: number) {
  return {
    id: _rowId++,
    orgId: ORG_ID,
    datasetId: DATASET_ID,
    sourceType: 'csv' as const,
    category,
    parentCategory,
    date,
    amount: amount.toFixed(2),
    label: null,
    metadata: null,
    createdAt: new Date(),
  };
}

function buildFixtureRows() {
  const rows = [];
  for (let m = 0; m < 12; m++) {
    rows.push(row('Revenue', 'Income', new Date(2025, m, 15), 8000));
    rows.push(row('COGS', 'Expenses', new Date(2025, m, 15), 6000));
  }
  for (let m = 0; m < 9; m++) {
    rows.push(row('Revenue', 'Income', new Date(2026, m, 15), 8800));
    rows.push(row('COGS', 'Expenses', new Date(2026, m, 15), 6000));
  }
  for (let m = 9; m < 12; m++) {
    rows.push(row('Revenue', 'Income', new Date(2026, m, 15), 8800));
    rows.push(row('COGS', 'Expenses', new Date(2026, m, 15), 10500));
  }
  return rows;
}

const fixtureRows = buildFixtureRows();

// Computed at test run time, not a fixed literal: fetchAndResolveStat doesn't
// inject a fixed `now` (it uses the real clock, same as the routes it backs),
// so Runway's 180-day staleness check needs a cashAsOfDate that's fresh
// relative to whenever this suite actually runs.
const freshFinancials = {
  cashOnHand: 20_000,
  cashAsOfDate: new Date().toISOString(),
  monthlyFixedCosts: 5_000,
};

function findRunwayId(): string {
  const identified = assignIds(computeStats(fixtureRows, { financials: freshFinancials }), DATASET_ID);
  const runway = identified.find(
    (s): s is Extract<IdentifiedStat, { statType: 'runway' }> => s.statType === StatType.Runway,
  );
  if (!runway) throw new Error('fixture did not produce a runway stat');
  return runway.id;
}

describe('fetchAndResolveStat', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetRowsByDataset.mockResolvedValue(fixtureRows);
    mockGetBusinessProfile.mockResolvedValue(freshFinancials);
  });

  it('resolves rows and the identified stat for a valid id', async () => {
    const statId = findRunwayId();
    const result = await fetchAndResolveStat(ORG_ID, false, DATASET_ID, statId);

    expect(result).not.toBeNull();
    expect(result!.stat.statType).toBe(StatType.Runway);
    expect(result!.rows).toBe(fixtureRows);
    expect(mockGetRowsByDataset).toHaveBeenCalledWith(ORG_ID, DATASET_ID, {});
    expect(mockGetBusinessProfile).toHaveBeenCalledWith(ORG_ID);
  });

  it('returns null and logs the shared warning for an id that never resolves', async () => {
    const statId = `${DATASET_ID}:total:Nonexistent:category`;
    const result = await fetchAndResolveStat(ORG_ID, false, DATASET_ID, statId);

    expect(result).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: ORG_ID, datasetId: DATASET_ID, statId }),
      'stat citation not found on recompute',
    );
  });

  it.each([0, -1, Number.NaN, 1.5])('returns null without querying the DB for an invalid datasetId %s', async (bad) => {
    const result = await fetchAndResolveStat(ORG_ID, false, bad, 'anything');

    expect(result).toBeNull();
    expect(mockGetRowsByDataset).not.toHaveBeenCalled();
  });
});

describe('resolveCitation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetRowsByDataset.mockResolvedValue(fixtureRows);
    mockGetBusinessProfile.mockResolvedValue(freshFinancials);
  });

  it('returns a CitationResponse whose detail matches buildStatDetail for the same runway id', async () => {
    const statId = findRunwayId();
    const expectedStat = assignIds(computeStats(fixtureRows, { financials: freshFinancials }), DATASET_ID)
      .find((s) => s.id === statId)!;

    const result = await resolveCitation(ORG_ID, false, DATASET_ID, statId);

    expect(result).toEqual({
      statId,
      datasetId: DATASET_ID,
      statType: StatType.Runway,
      value: expectedStat.value,
      detail: buildStatDetail(expectedStat),
    });
  });

  it('returns null without throwing for an id that was never computed', async () => {
    await expect(
      resolveCitation(ORG_ID, false, DATASET_ID, `${DATASET_ID}:total:Nonexistent:category`),
    ).resolves.toBeNull();
  });

  it('returns null for a cross-org id: RLS-scoped fetch returns zero rows so nothing resolves', async () => {
    const statId = findRunwayId();
    mockGetRowsByDataset.mockResolvedValueOnce([]);

    await expect(resolveCitation(ORG_ID, false, DATASET_ID, statId)).resolves.toBeNull();
  });

  it('returns null for a stale id once cashAsOfDate ages past the 180-day suppression window', async () => {
    const statId = findRunwayId();
    mockGetBusinessProfile.mockResolvedValueOnce({ ...freshFinancials, cashAsOfDate: '2020-01-01T00:00:00.000Z' });

    await expect(resolveCitation(ORG_ID, false, DATASET_ID, statId)).resolves.toBeNull();
  });

  it('CitationResponse carries no row-shaped field: only statId/datasetId/statType/value/detail', async () => {
    const statId = findRunwayId();
    const result = await resolveCitation(ORG_ID, false, DATASET_ID, statId);

    expect(result).not.toBeNull();
    expect(Object.keys(result!).sort()).toEqual(['datasetId', 'detail', 'statId', 'statType', 'value']);
  });
});
