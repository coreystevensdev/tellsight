import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';

import { computeStats, assignIds } from '../services/curation/computation.js';
import { StatType } from '../services/curation/types.js';
import type { IdentifiedStat } from '../services/curation/types.js';
import { statCitationTotal } from '../lib/metrics.js';

vi.mock('../config.js', () => ({
  env: {
    CLAUDE_API_KEY: 'test-key',
    CLAUDE_MODEL: 'claude-sonnet-4-5-20250929',
  },
}));

vi.mock('../lib/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnValue({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  },
}));

vi.mock('../lib/redis.js', () => ({
  redis: { connect: vi.fn(), on: vi.fn(), ping: vi.fn() },
}));

vi.mock('../lib/db.js', () => ({
  db: {},
  dbAdmin: {},
}));

const mockGetCachedSummary = vi.fn();
const mockGetLatestSummary = vi.fn();
const mockGetMonthlyAiUsageCount = vi.fn().mockResolvedValue(0);
const mockGetRowsByDataset = vi.fn().mockResolvedValue([]);
const mockGetBusinessProfile = vi.fn().mockResolvedValue(null);
vi.mock('../db/queries/index.js', () => ({
  aiSummariesQueries: {
    getCachedSummary: (...args: unknown[]) => mockGetCachedSummary(...args),
    getLatestSummary: (...args: unknown[]) => mockGetLatestSummary(...args),
  },
  analyticsEventsQueries: {
    getMonthlyAiUsageCount: (...args: unknown[]) => mockGetMonthlyAiUsageCount(...args),
  },
  dataRowsQueries: {
    getRowCount: vi.fn().mockResolvedValue(100),
    getRowsByDataset: (...args: unknown[]) => mockGetRowsByDataset(...args),
  },
  orgsQueries: {
    getBusinessProfile: (...args: unknown[]) => mockGetBusinessProfile(...args),
  },
  subscriptionsQueries: {
    getActiveTier: vi.fn().mockResolvedValue('free'),
  },
}));

vi.mock('../lib/metrics.js', () => ({
  aiSummaryTotal: { inc: vi.fn() },
  aiTokensUsed: { inc: vi.fn() },
  statCitationTotal: { inc: vi.fn() },
}));

const mockTrackEvent = vi.fn();
vi.mock('../services/analytics/trackEvent.js', () => ({
  trackEvent: (...args: unknown[]) => mockTrackEvent(...args),
}));

vi.mock('../lib/rls.js', () => ({
  withRlsContext: vi.fn((_orgId: number, _isAdmin: boolean, fn: (tx: unknown) => Promise<unknown>) => fn({})),
}));

const mockStreamToSSE = vi.fn();
vi.mock('../services/aiInterpretation/streamHandler.js', () => ({
  streamToSSE: (...args: unknown[]) => mockStreamToSSE(...args),
}));

vi.mock('../middleware/rateLimiter.js', () => ({
  rateLimitAi: (_req: unknown, _res: unknown, next: () => void) => next(),
  rateLimitPublic: (_req: unknown, _res: unknown, next: () => void) => next(),
  rateLimitAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
  rateLimitDashboardCompute: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock('../services/auth/tokenService.js', () => ({
  verifyAccessToken: vi.fn(),
}));

vi.mock('../middleware/authMiddleware.js', () => ({
  authMiddleware: vi.fn((req: unknown, _res: unknown, next: () => void) => {
    (req as { user: { sub: string; org_id: number } }).user = { sub: '1', org_id: 1 };
    next();
  }),
}));

vi.mock('../middleware/subscriptionGate.js', () => ({
  subscriptionGate: vi.fn((req: unknown, _res: unknown, next: () => void) => {
    (req as { subscriptionTier: string }).subscriptionTier = 'free';
    next();
  }),
}));

vi.mock('../db/queries/subscriptions.js', () => ({
  getActiveTier: vi.fn().mockResolvedValue('free'),
}));

const { createTestApp } = await import('../test/helpers/testApp.js');
const { default: protectedRouter } = await import('./protected.js');

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  const result = await createTestApp((app) => {
    app.use('/', protectedRouter);
  });
  server = result.server;
  baseUrl = result.baseUrl;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /ai-summaries/:datasetId', () => {
  it('returns cached summary as JSON when cache hits', async () => {
    mockGetCachedSummary.mockResolvedValue({
      content: 'Cached summary text',
      transparencyMetadata: { promptVersion: 'v1' },
    });

    const res = await fetch(`${baseUrl}/ai-summaries/42`);
    const body = await res.json() as { data: { content: string; fromCache: boolean } };

    expect(res.status).toBe(200);
    expect(body.data.content).toBe('Cached summary text');
    expect(body.data.fromCache).toBe(true);
    expect(mockStreamToSSE).not.toHaveBeenCalled();
  });

  it('calls streamToSSE on cache miss', async () => {
    mockGetCachedSummary.mockResolvedValue(null);
    mockStreamToSSE.mockImplementation(async (res: { end: () => void }) => {
      res.end();
      return { ok: true };
    });

    await fetch(`${baseUrl}/ai-summaries/42`);

    expect(mockStreamToSSE).toHaveBeenCalledOnce();
    const args = mockStreamToSSE.mock.calls[0]!;
    expect(args[1]).toBe(1);     // orgId
    expect(args[2]).toBe(42);    // datasetId
    expect(typeof args[3]).toBe('number'); // userId from JWT
    expect(args[4]).toBe('free'); // tier
  });

  it('rejects invalid datasetId', async () => {
    const res = await fetch(`${baseUrl}/ai-summaries/abc`);
    const body = await res.json() as { error: { code: string } };

    expect(res.status).toBe(400);
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects negative datasetId', async () => {
    const res = await fetch(`${baseUrl}/ai-summaries/-1`);
    expect(res.status).toBe(400);
  });

  it('fires AI_SUMMARY_REQUESTED analytics event', async () => {
    mockGetCachedSummary.mockResolvedValue({
      content: 'test',
      transparencyMetadata: {},
    });

    await fetch(`${baseUrl}/ai-summaries/42`);

    expect(mockTrackEvent).toHaveBeenCalledWith(
      1,
      1,
      'ai.summary_requested',
      { datasetId: 42 },
    );
  });
});

describe('GET /ai-summaries/:datasetId/latest', () => {
  it('returns latest summary with null staleAt when fresh', async () => {
    mockGetLatestSummary.mockResolvedValueOnce({
      content: 'Fresh cached analysis.',
      transparencyMetadata: { promptVersion: 'v1' },
      staleAt: null,
    });

    const res = await fetch(`${baseUrl}/ai-summaries/42/latest`);
    const body = await res.json() as { data: { content: string; staleAt: string | null } };

    expect(res.status).toBe(200);
    expect(body.data.content).toBe('Fresh cached analysis.');
    expect(body.data.staleAt).toBeNull();
  });

  it('surfaces staleAt as ISO string when summary is stale', async () => {
    const staleAt = new Date('2026-04-17T14:00:00.000Z');
    mockGetLatestSummary.mockResolvedValueOnce({
      content: 'Prior analysis from before the QB sync.',
      transparencyMetadata: null,
      staleAt,
    });

    const res = await fetch(`${baseUrl}/ai-summaries/42/latest`);
    const body = await res.json() as { data: { staleAt: string } };

    expect(res.status).toBe(200);
    expect(body.data.staleAt).toBe('2026-04-17T14:00:00.000Z');
  });

  it('returns 404 when no summary exists for this org + dataset', async () => {
    mockGetLatestSummary.mockResolvedValueOnce(null);

    const res = await fetch(`${baseUrl}/ai-summaries/42/latest`);
    const body = await res.json() as { error: { code: string } };

    expect(res.status).toBe(404);
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('rejects invalid datasetId', async () => {
    const res = await fetch(`${baseUrl}/ai-summaries/abc/latest`);
    expect(res.status).toBe(400);
  });

  it('scopes the query to the authenticated org', async () => {
    mockGetLatestSummary.mockResolvedValueOnce({
      content: 'x',
      transparencyMetadata: null,
      staleAt: null,
    });

    await fetch(`${baseUrl}/ai-summaries/42/latest`);

    expect(mockGetLatestSummary).toHaveBeenCalledWith(1, 42, expect.anything());
  });
});

// Real pipeline, same fixture shape as statId.test.ts: 6 Sales rows (one
// outlier) + 3 Expenses rows, enough to produce a Total (formula-kind) and
// an Anomaly (inputs-kind) stat for the route tests below.
const detailFixtureRows = [
  { id: 1, orgId: 1, datasetId: 42, sourceType: 'csv' as const, category: 'Sales', parentCategory: null, date: new Date('2025-01-01'), amount: '1000.00', label: null, metadata: null, createdAt: new Date() },
  { id: 2, orgId: 1, datasetId: 42, sourceType: 'csv' as const, category: 'Sales', parentCategory: null, date: new Date('2025-02-01'), amount: '1100.00', label: null, metadata: null, createdAt: new Date() },
  { id: 3, orgId: 1, datasetId: 42, sourceType: 'csv' as const, category: 'Sales', parentCategory: null, date: new Date('2025-03-01'), amount: '1200.00', label: null, metadata: null, createdAt: new Date() },
  { id: 4, orgId: 1, datasetId: 42, sourceType: 'csv' as const, category: 'Sales', parentCategory: null, date: new Date('2026-01-01'), amount: '1300.00', label: null, metadata: null, createdAt: new Date() },
  { id: 5, orgId: 1, datasetId: 42, sourceType: 'csv' as const, category: 'Sales', parentCategory: null, date: new Date('2026-02-01'), amount: '1400.00', label: null, metadata: null, createdAt: new Date() },
  { id: 6, orgId: 1, datasetId: 42, sourceType: 'csv' as const, category: 'Sales', parentCategory: null, date: new Date('2026-03-01'), amount: '9000.00', label: null, metadata: null, createdAt: new Date() },
  { id: 7, orgId: 1, datasetId: 42, sourceType: 'csv' as const, category: 'Expenses', parentCategory: null, date: new Date('2026-01-01'), amount: '500.00', label: null, metadata: null, createdAt: new Date() },
  { id: 8, orgId: 1, datasetId: 42, sourceType: 'csv' as const, category: 'Expenses', parentCategory: null, date: new Date('2026-02-01'), amount: '520.00', label: null, metadata: null, createdAt: new Date() },
  { id: 9, orgId: 1, datasetId: 42, sourceType: 'csv' as const, category: 'Expenses', parentCategory: null, date: new Date('2026-03-01'), amount: '510.00', label: null, metadata: null, createdAt: new Date() },
];

function detailFixtureId<T extends StatType>(
  statType: T,
  predicate: (s: Extract<IdentifiedStat, { statType: T }>) => boolean,
): string {
  const found = assignIds(computeStats(detailFixtureRows), 42).find(
    (s): s is Extract<IdentifiedStat, { statType: T }> =>
      s.statType === statType && predicate(s as Extract<IdentifiedStat, { statType: T }>),
  );
  if (!found) throw new Error(`detailFixtureRows did not produce a matching ${statType} stat`);
  return found.id;
}

describe('GET /ai-summaries/:datasetId/stats/:statId', () => {
  beforeEach(() => {
    mockGetRowsByDataset.mockResolvedValue(detailFixtureRows);
    mockGetBusinessProfile.mockResolvedValue(null);
  });

  it('returns 200 with a formula-kind detail for an arithmetic stat', async () => {
    const statId = detailFixtureId(StatType.Total, (s) => s.category === 'Sales' && s.details.scope === 'category');

    const res = await fetch(`${baseUrl}/ai-summaries/42/stats/${encodeURIComponent(statId)}`);
    const body = await res.json() as { data: { statType: string; value: number; detail: { kind: string } } };

    expect(res.status).toBe(200);
    expect(body.data.statType).toBe('total');
    expect(body.data.detail.kind).toBe('formula');
    expect(statCitationTotal.inc).toHaveBeenCalledWith({ outcome: 'ok' });
  });

  it('returns 200 with an inputs-kind detail for a statistical stat', async () => {
    const statId = detailFixtureId(StatType.Anomaly, () => true);

    const res = await fetch(`${baseUrl}/ai-summaries/42/stats/${encodeURIComponent(statId)}`);
    const body = await res.json() as { data: { detail: { kind: string } } };

    expect(res.status).toBe(200);
    expect(body.data.detail.kind).toBe('inputs');
  });

  it('returns 404 for an id that was never computed', async () => {
    const res = await fetch(`${baseUrl}/ai-summaries/42/stats/${encodeURIComponent('42:total:Nonexistent:category')}`);
    const body = await res.json() as { error: { code: string } };

    expect(res.status).toBe(404);
    expect(body.error.code).toBe('NOT_FOUND');
    expect(statCitationTotal.inc).toHaveBeenCalledWith({ outcome: 'not_found' });
  });

  it('returns 404 for a cross-org dataset, RLS-scoped fetch returns zero rows so no id ever matches', async () => {
    mockGetRowsByDataset.mockResolvedValueOnce([]);
    const statId = detailFixtureId(StatType.Total, (s) => s.category === 'Sales' && s.details.scope === 'category');

    const res = await fetch(`${baseUrl}/ai-summaries/42/stats/${encodeURIComponent(statId)}`);
    expect(res.status).toBe(404);
    expect(statCitationTotal.inc).toHaveBeenCalledWith({ outcome: 'not_found' });
  });

  it('rejects invalid datasetId', async () => {
    const res = await fetch(`${baseUrl}/ai-summaries/abc/stats/${encodeURIComponent('1:total:Sales:category')}`);
    expect(res.status).toBe(400);
  });
});

describe('GET /ai-summaries/:datasetId/stats/:statId/rows', () => {
  beforeEach(() => {
    mockGetRowsByDataset.mockResolvedValue(detailFixtureRows);
    mockGetBusinessProfile.mockResolvedValue(null);
  });

  it('returns a paginated page of source rows for a category-scoped stat', async () => {
    const statId = detailFixtureId(StatType.Total, (s) => s.category === 'Sales' && s.details.scope === 'category');

    const res = await fetch(`${baseUrl}/ai-summaries/42/stats/${encodeURIComponent(statId)}/rows?limit=2&offset=0`);
    const body = await res.json() as {
      data: unknown[];
      meta: { total: number; pagination: { page: number; pageSize: number; totalPages: number } };
    };

    expect(res.status).toBe(200);
    expect(body.data.length).toBe(2);
    expect(body.meta.total).toBe(6);
    expect(body.meta.pagination).toEqual({ page: 1, pageSize: 2, totalPages: 3 });
  });

  it('returns only the row(s) matching an anomaly citation', async () => {
    const statId = detailFixtureId(StatType.Anomaly, () => true);

    const res = await fetch(`${baseUrl}/ai-summaries/42/stats/${encodeURIComponent(statId)}/rows`);
    const body = await res.json() as { data: { category: string }[] };

    expect(res.status).toBe(200);
    expect(body.data.length).toBeGreaterThan(0);
    expect(body.data.every((r) => r.category === 'Sales')).toBe(true);
  });

  it('returns 404 for an id that was never computed', async () => {
    const res = await fetch(`${baseUrl}/ai-summaries/42/stats/${encodeURIComponent('42:total:Nonexistent:category')}/rows`);
    const body = await res.json() as { error: { code: string } };

    expect(res.status).toBe(404);
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('returns 404 for a cross-org dataset, RLS-scoped fetch returns zero rows so no id ever matches', async () => {
    mockGetRowsByDataset.mockResolvedValueOnce([]);
    const statId = detailFixtureId(StatType.Total, (s) => s.category === 'Sales' && s.details.scope === 'category');

    const res = await fetch(`${baseUrl}/ai-summaries/42/stats/${encodeURIComponent(statId)}/rows`);
    expect(res.status).toBe(404);
  });

  it('rejects a zero limit', async () => {
    const statId = detailFixtureId(StatType.Total, (s) => s.category === 'Sales' && s.details.scope === 'category');
    const res = await fetch(`${baseUrl}/ai-summaries/42/stats/${encodeURIComponent(statId)}/rows?limit=0`);
    const body = await res.json() as { error: { code: string } };

    expect(res.status).toBe(400);
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects a non-numeric offset', async () => {
    const statId = detailFixtureId(StatType.Total, (s) => s.category === 'Sales' && s.details.scope === 'category');
    const res = await fetch(`${baseUrl}/ai-summaries/42/stats/${encodeURIComponent(statId)}/rows?offset=abc`);
    expect(res.status).toBe(400);
  });

  it('returns an empty page with the real total when offset is past the end', async () => {
    const statId = detailFixtureId(StatType.Total, (s) => s.category === 'Sales' && s.details.scope === 'category');

    const res = await fetch(`${baseUrl}/ai-summaries/42/stats/${encodeURIComponent(statId)}/rows?limit=10&offset=100`);
    const body = await res.json() as {
      data: unknown[];
      meta: { total: number; pagination: { totalPages: number } };
    };

    expect(res.status).toBe(200);
    expect(body.data).toEqual([]);
    expect(body.meta.total).toBe(6);
    expect(body.meta.pagination.totalPages).toBe(1);
  });
});
