import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';

const mockVerifyAccessToken = vi.fn();
const mockGetAgentEnabled = vi.fn();
const mockRunQaLoop = vi.fn();
const mockAssembleQaAnswer = vi.fn();
const mockTrackEvent = vi.fn();

vi.mock('../services/auth/tokenService.js', () => ({
  verifyAccessToken: mockVerifyAccessToken,
}));

vi.mock('../db/queries/index.js', () => ({
  subscriptionsQueries: {
    getAgentEnabled: mockGetAgentEnabled,
  },
}));

vi.mock('../services/curation/qaLoop.js', () => ({
  runQaLoop: mockRunQaLoop,
}));

vi.mock('../services/curation/qaAnswer.js', () => ({
  assembleQaAnswer: mockAssembleQaAnswer,
}));

vi.mock('../services/analytics/trackEvent.js', () => ({
  trackEvent: (...args: unknown[]) => mockTrackEvent(...args),
}));

const mockRateLimitAi = vi.fn((_req: unknown, _res: unknown, next: () => void) => next());
vi.mock('../middleware/rateLimiter.js', () => ({
  rateLimitAi: (req: unknown, res: unknown, next: () => void) => mockRateLimitAi(req, res, next),
}));

vi.mock('../config.js', () => ({
  env: { NODE_ENV: 'test', APP_URL: 'http://localhost:3000' },
}));

vi.mock('../lib/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnValue({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  },
}));

const { createTestApp } = await import('../test/helpers/testApp.js');
const { authMiddleware } = await import('../middleware/authMiddleware.js');
const { qaRouter } = await import('./qa.js');

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  const result = await createTestApp((app) => {
    app.use(authMiddleware);
    app.use('/qa', qaRouter);
  });
  server = result.server;
  baseUrl = result.baseUrl;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

beforeEach(() => vi.clearAllMocks());

function ownerPayload() {
  return {
    sub: '5',
    org_id: 10,
    role: 'owner',
    isAdmin: false,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 900,
  };
}

const authHeaders = {
  Cookie: 'access_token=valid-jwt',
  'Content-Type': 'application/json',
};

const mockLoopResult = {
  answer: 'Not financial advice.',
  toolResults: [],
  termination: 'answered' as const,
  turnCount: 1,
};

const mockAnswer = {
  answer: 'Revenue grew 12% <cite id="7:total:Sales:category"/> this quarter. Not financial advice.',
  citedStatIds: ['7:total:Sales:category'],
  termination: 'answered' as const,
  turnCount: 1,
};

describe('POST /qa/:datasetId', () => {
  it('returns the assembled answer on the happy path', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(ownerPayload());
    mockGetAgentEnabled.mockResolvedValueOnce(true);
    mockRunQaLoop.mockResolvedValueOnce(mockLoopResult);
    mockAssembleQaAnswer.mockReturnValueOnce(mockAnswer);

    const before = Date.now();
    const res = await fetch(`${baseUrl}/qa/7`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ question: 'How did revenue trend this quarter?' }),
    });
    const after = Date.now();
    const json = (await res.json()) as { data: typeof mockAnswer };

    expect(res.status).toBe(200);
    expect(json.data).toEqual(mockAnswer);
    // now bounded to the actual request window, not just asserted to be *a*
    // Date, so a bug that captured it at module load or from a stale value
    // would fail this instead of passing under expect.any(Date).
    const actualCtx = mockRunQaLoop.mock.calls[0]![1] as { now: Date };
    expect(actualCtx.now.getTime()).toBeGreaterThanOrEqual(before);
    expect(actualCtx.now.getTime()).toBeLessThanOrEqual(after);
    expect(mockRunQaLoop).toHaveBeenCalledWith(
      'How did revenue trend this quarter?',
      { orgId: 10, isAdmin: false, datasetId: 7, now: actualCtx.now },
      expect.anything(),
    );
    expect(mockAssembleQaAnswer).toHaveBeenCalledWith(mockLoopResult);
    expect(mockTrackEvent).toHaveBeenCalledWith(10, 5, 'qa.question_asked', { datasetId: 7 });
  });

  it('rejects an empty question with 400 before touching the loop', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(ownerPayload());

    const res = await fetch(`${baseUrl}/qa/7`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ question: '' }),
    });
    const json = (await res.json()) as { error: { code: string } };

    expect(res.status).toBe(400);
    expect(json.error.code).toBe('VALIDATION_ERROR');
    expect(mockGetAgentEnabled).not.toHaveBeenCalled();
    expect(mockRunQaLoop).not.toHaveBeenCalled();
  });

  it('rejects a question over 500 characters with 400 before touching the loop', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(ownerPayload());

    const res = await fetch(`${baseUrl}/qa/7`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ question: 'a'.repeat(501) }),
    });
    const json = (await res.json()) as { error: { code: string } };

    expect(res.status).toBe(400);
    expect(json.error.code).toBe('VALIDATION_ERROR');
    expect(mockRunQaLoop).not.toHaveBeenCalled();
  });

  it('returns 403 and skips the loop when the org lacks agent_enabled', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(ownerPayload());
    mockGetAgentEnabled.mockResolvedValueOnce(false);

    const res = await fetch(`${baseUrl}/qa/7`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ question: 'How is my runway?' }),
    });
    const json = (await res.json()) as { error: { code: string } };

    expect(res.status).toBe(403);
    expect(json.error.code).toBe('AGENT_TIER_REQUIRED');
    expect(mockRunQaLoop).not.toHaveBeenCalled();
  });

  it('returns 500 when the loop throws', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(ownerPayload());
    mockGetAgentEnabled.mockResolvedValueOnce(true);
    mockRunQaLoop.mockRejectedValueOnce(new Error('claude api down'));

    const res = await fetch(`${baseUrl}/qa/7`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ question: 'How is my runway?' }),
    });
    const json = (await res.json()) as { error: { code: string } };

    expect(res.status).toBe(500);
    expect(json.error.code).toBe('QA_LOOP_FAILED');
  });

  it('does not hang when rateLimitAi responds 429 without calling next (regression)', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(ownerPayload());
    mockGetAgentEnabled.mockResolvedValueOnce(true);
    // Mirrors the real rateLimitAi's actual-limit branch: it responds via
    // res directly and never invokes the third (next) argument.
    mockRateLimitAi.mockImplementationOnce((_req: unknown, res: unknown) => {
      (res as { status: (n: number) => { json: (b: unknown) => void } }).status(429).json({
        error: { code: 'RATE_LIMITED', message: 'Too many requests' },
      });
    });

    const res = await fetch(`${baseUrl}/qa/7`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ question: 'How is my runway?' }),
    });
    const json = (await res.json()) as { error: { code: string } };

    expect(res.status).toBe(429);
    expect(json.error.code).toBe('RATE_LIMITED');
    expect(mockRunQaLoop).not.toHaveBeenCalled();
  });

  it('deregisters the abort controller even when rateLimitAi rejects with a real error (regression)', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(ownerPayload());
    mockGetAgentEnabled.mockResolvedValueOnce(true);
    mockRateLimitAi.mockImplementationOnce((_req: unknown, _res: unknown, next: (err?: unknown) => void) => {
      next(new Error('redis unavailable'));
    });

    const { activeCount } = await import('../lib/activeStreams.js');
    const before = activeCount();

    const res = await fetch(`${baseUrl}/qa/7`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ question: 'How is my runway?' }),
    });

    expect(res.status).toBe(500);
    expect(mockRunQaLoop).not.toHaveBeenCalled();
    expect(activeCount()).toBe(before);
  });

  it('does not log an error when runQaLoop rejects with an AbortError that was not caused by a client disconnect', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(ownerPayload());
    mockGetAgentEnabled.mockResolvedValueOnce(true);
    mockRunQaLoop.mockRejectedValueOnce(new DOMException('aborted', 'AbortError'));

    const { logger } = await import('../lib/logger.js');
    const res = await fetch(`${baseUrl}/qa/7`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ question: 'How is my runway?' }),
    });

    // Still connected, so the client gets a response -- just not logged as
    // a failure, since an AbortError here is expected cancellation noise
    // (e.g. an app-wide abortAll() on shutdown), not a real backend error.
    expect(res.status).toBe(500);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('logs a genuine runQaLoop failure even though it is not an AbortError', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(ownerPayload());
    mockGetAgentEnabled.mockResolvedValueOnce(true);
    mockRunQaLoop.mockRejectedValueOnce(new Error('claude api down'));

    const { logger } = await import('../lib/logger.js');
    const res = await fetch(`${baseUrl}/qa/7`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ question: 'How is my runway?' }),
    });

    expect(res.status).toBe(500);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: 10, datasetId: 7 }),
      'qa loop failed',
    );
  });

  it('returns 401 without auth', async () => {
    const res = await fetch(`${baseUrl}/qa/7`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: 'How is my runway?' }),
    });

    expect(res.status).toBe(401);
    expect(mockRunQaLoop).not.toHaveBeenCalled();
  });

  it('rejects a non-numeric dataset id', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(ownerPayload());

    const res = await fetch(`${baseUrl}/qa/abc`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ question: 'How is my runway?' }),
    });

    expect(res.status).toBe(400);
    expect(mockRunQaLoop).not.toHaveBeenCalled();
  });

  it('aborts the loop signal and does not crash when the client disconnects mid-loop', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(ownerPayload());
    mockGetAgentEnabled.mockResolvedValueOnce(true);

    let capturedSignal: AbortSignal | undefined;
    mockRunQaLoop.mockImplementationOnce((_question: string, _ctx: unknown, signal?: AbortSignal) => {
      capturedSignal = signal;
      return new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    });

    // fetch/undici's client-side abort doesn't reliably close the underlying
    // socket over loopback. node:http's req.destroy() forces it closed.
    const url = new URL(`${baseUrl}/qa/7`);
    const body = JSON.stringify({ question: 'How is my runway?' });
    const clientReq = http.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'POST',
      headers: { ...authHeaders, 'Content-Length': Buffer.byteLength(body) },
    });
    clientReq.on('error', () => {
      // expected once the socket is force-destroyed below
    });
    clientReq.end(body);

    await vi.waitFor(() => expect(mockRunQaLoop).toHaveBeenCalled());
    clientReq.destroy();

    await vi.waitFor(() => expect(capturedSignal?.aborted).toBe(true));
  });

  it('answers with no cited stats when the dataset belongs to another org (RLS isolation)', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(ownerPayload());
    mockGetAgentEnabled.mockResolvedValueOnce(true);
    // Tool functions resolve RLS internally; a cross-org dataset just means
    // the loop's own tool calls find nothing, not that this route 404s.
    mockRunQaLoop.mockResolvedValueOnce({ ...mockLoopResult, toolResults: [] });
    mockAssembleQaAnswer.mockReturnValueOnce({ ...mockAnswer, citedStatIds: [] });

    const res = await fetch(`${baseUrl}/qa/999`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ question: 'How is my runway?' }),
    });
    const json = (await res.json()) as { data: { citedStatIds: string[] } };

    expect(res.status).toBe(200);
    expect(json.data.citedStatIds).toEqual([]);
  });
});
