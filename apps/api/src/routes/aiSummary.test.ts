import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';

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
  },
  orgsQueries: {
    getBusinessProfile: vi.fn().mockResolvedValue(null),
  },
  subscriptionsQueries: {
    getActiveTier: vi.fn().mockResolvedValue('free'),
  },
}));

vi.mock('../lib/metrics.js', () => ({
  aiSummaryTotal: { inc: vi.fn() },
  aiTokensUsed: { inc: vi.fn() },
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
    mockStreamToSSE.mockImplementation(async (_req: unknown, res: { end: () => void }) => {
      res.end();
      return { ok: true };
    });

    await fetch(`${baseUrl}/ai-summaries/42`);

    expect(mockStreamToSSE).toHaveBeenCalledOnce();
    const args = mockStreamToSSE.mock.calls[0]!;
    expect(args[2]).toBe(1);     // orgId
    expect(args[3]).toBe(42);    // datasetId
    expect(typeof args[4]).toBe('number'); // userId from JWT
    expect(args[5]).toBe('free'); // tier
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
