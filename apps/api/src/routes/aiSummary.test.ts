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
const mockGetMonthlyAiUsageCount = vi.fn().mockResolvedValue(0);
vi.mock('../db/queries/index.js', () => ({
  aiSummariesQueries: {
    getCachedSummary: (...args: unknown[]) => mockGetCachedSummary(...args),
  },
  analyticsEventsQueries: {
    getMonthlyAiUsageCount: (...args: unknown[]) => mockGetMonthlyAiUsageCount(...args),
  },
  subscriptionsQueries: {
    getActiveTier: vi.fn().mockResolvedValue('free'),
  },
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

    expect(mockStreamToSSE).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      1,
      42,
      'free',
      expect.anything(),
    );
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
