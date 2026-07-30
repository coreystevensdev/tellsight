import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import type { Response } from 'express';

const mockVerifyAccessToken = vi.fn();
const mockGetCorrectionsByDataset = vi.fn();
const mockCreateCorrection = vi.fn();
const mockGetDatasetById = vi.fn();

const mockRateLimitStatCorrectionTier1Factory = vi.fn(
  (_statInstanceId: string) => (_req: unknown, _res: Response, next: () => void) => next(),
);
vi.mock('../middleware/rateLimiter.js', () => ({
  rateLimitStatCorrectionTier1: (statInstanceId: string) =>
    mockRateLimitStatCorrectionTier1Factory(statInstanceId),
}));

vi.mock('../services/auth/tokenService.js', () => ({
  verifyAccessToken: mockVerifyAccessToken,
}));

vi.mock('../db/queries/index.js', () => ({
  statCorrectionsQueries: {
    getCorrectionsByDataset: mockGetCorrectionsByDataset,
    createCorrection: mockCreateCorrection,
  },
  datasetsQueries: {
    getDatasetById: mockGetDatasetById,
  },
}));

vi.mock('../lib/rls.js', () => ({
  withRlsContext: vi.fn((_orgId: number, _isAdmin: boolean, fn: (tx: unknown) => Promise<unknown>) => fn({})),
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
const { statCorrectionsRouter } = await import('./statCorrections.js');
const { ConflictError } = await import('../lib/appError.js');

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  const result = await createTestApp((app) => {
    app.use(authMiddleware);
    app.use('/stat-corrections', statCorrectionsRouter);
  });
  server = result.server;
  baseUrl = result.baseUrl;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

beforeEach(() => vi.clearAllMocks());

function ownerPayload(overrides: Partial<{ role: string; org_id: number }> = {}) {
  return {
    sub: '5',
    org_id: 10,
    role: 'owner',
    isAdmin: false,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 900,
    ...overrides,
  };
}

const authHeaders = {
  Cookie: 'access_token=valid-jwt',
  'Content-Type': 'application/json',
};

const mockDataset = { id: 7, orgId: 10 };

const mockCorrection = {
  id: 1,
  orgId: 10,
  datasetId: 7,
  statInstanceId: '7:runway:_:_',
  note: 'This double-counts the SBA loan',
  appliesGoingForward: false,
  status: null,
  createdAt: '2026-07-22T00:00:00.000Z',
  expiresAt: null,
};

describe('GET /stat-corrections/:datasetId', () => {
  it('returns corrections for the dataset', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(ownerPayload({ role: 'member' }));
    mockGetCorrectionsByDataset.mockResolvedValueOnce([mockCorrection]);

    const res = await fetch(`${baseUrl}/stat-corrections/7`, { headers: authHeaders });
    const json = (await res.json()) as { data: unknown[] };

    expect(res.status).toBe(200);
    expect(json.data).toHaveLength(1);
    expect(mockGetCorrectionsByDataset).toHaveBeenCalledWith(10, 7, expect.anything());
  });

  it('rejects a non-numeric dataset id', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(ownerPayload());

    const res = await fetch(`${baseUrl}/stat-corrections/abc`, { headers: authHeaders });

    expect(res.status).toBe(400);
  });

  it('returns 401 without auth', async () => {
    const res = await fetch(`${baseUrl}/stat-corrections/7`);
    expect(res.status).toBe(401);
  });
});

describe('POST /stat-corrections', () => {
  it('creates a Tier 1 annotation as owner', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(ownerPayload());
    mockGetDatasetById.mockResolvedValueOnce(mockDataset);
    mockCreateCorrection.mockResolvedValueOnce(mockCorrection);

    const res = await fetch(`${baseUrl}/stat-corrections`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        datasetId: 7,
        statInstanceId: '7:runway:_:_',
        note: 'This double-counts the SBA loan',
      }),
    });
    const json = (await res.json()) as { data: { id: number } };

    expect(res.status).toBe(201);
    expect(json.data.id).toBe(1);
    expect(mockCreateCorrection).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: 10, userId: 5, appliesGoingForward: false }),
      expect.anything(),
    );
  });

  it('creates a Tier 2 request with appliesGoingForward true', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(ownerPayload());
    mockGetDatasetById.mockResolvedValueOnce(mockDataset);
    mockCreateCorrection.mockResolvedValueOnce({ ...mockCorrection, appliesGoingForward: true, status: 'pending' });

    const res = await fetch(`${baseUrl}/stat-corrections`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        datasetId: 7,
        statInstanceId: '7:runway:_:_',
        note: 'This should apply going forward',
        appliesGoingForward: true,
      }),
    });
    const json = (await res.json()) as { data: { status: string } };

    expect(res.status).toBe(201);
    expect(json.data.status).toBe('pending');
    expect(mockCreateCorrection).toHaveBeenCalledWith(
      expect.objectContaining({ appliesGoingForward: true }),
      expect.anything(),
    );
  });

  it('rejects an empty note', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(ownerPayload());

    const res = await fetch(`${baseUrl}/stat-corrections`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ datasetId: 7, statInstanceId: '7:runway:_:_', note: '' }),
    });
    const json = (await res.json()) as { error: { code: string } };

    expect(res.status).toBe(400);
    expect(json.error.code).toBe('VALIDATION_ERROR');
    expect(mockCreateCorrection).not.toHaveBeenCalled();
  });

  it('allows a non-owner org member to create a Tier 1 annotation', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(ownerPayload({ role: 'member' }));
    mockGetDatasetById.mockResolvedValueOnce(mockDataset);
    mockCreateCorrection.mockResolvedValueOnce(mockCorrection);

    const res = await fetch(`${baseUrl}/stat-corrections`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ datasetId: 7, statInstanceId: '7:runway:_:_', note: 'note' }),
    });

    expect(res.status).toBe(201);
    expect(mockCreateCorrection).toHaveBeenCalledWith(
      expect.objectContaining({ appliesGoingForward: false }),
      expect.anything(),
    );
  });

  it('rejects a non-owner org member requesting Tier 2 (appliesGoingForward) with 403', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(ownerPayload({ role: 'member' }));

    const res = await fetch(`${baseUrl}/stat-corrections`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        datasetId: 7,
        statInstanceId: '7:runway:_:_',
        note: 'note',
        appliesGoingForward: true,
      }),
    });
    const json = (await res.json()) as { error: { code: string } };

    expect(res.status).toBe(403);
    expect(json.error.code).toBe('FORBIDDEN');
    expect(mockCreateCorrection).not.toHaveBeenCalled();
  });

  it('returns 401 without auth on POST', async () => {
    const res = await fetch(`${baseUrl}/stat-corrections`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ datasetId: 7, statInstanceId: '7:runway:_:_', note: 'note' }),
    });
    expect(res.status).toBe(401);
  });

  it('returns 404 when the dataset belongs to a different org', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(ownerPayload());
    mockGetDatasetById.mockResolvedValueOnce(undefined);

    const res = await fetch(`${baseUrl}/stat-corrections`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ datasetId: 999, statInstanceId: '999:runway:_:_', note: 'note' }),
    });

    expect(res.status).toBe(404);
    expect(mockCreateCorrection).not.toHaveBeenCalled();
  });

  it('returns 409 when an active Tier 2 request already exists for the stat', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(ownerPayload());
    mockGetDatasetById.mockResolvedValueOnce(mockDataset);
    mockCreateCorrection.mockRejectedValueOnce(
      new ConflictError('A pending or approved correction already exists for this stat'),
    );

    const res = await fetch(`${baseUrl}/stat-corrections`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        datasetId: 7,
        statInstanceId: '7:runway:_:_',
        note: 'note',
        appliesGoingForward: true,
      }),
    });
    const json = (await res.json()) as { error: { code: string } };

    expect(res.status).toBe(409);
    expect(json.error.code).toBe('CONFLICT');
  });

  it('invokes the Tier 1 rate limiter guard for a Tier 1 submission', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(ownerPayload());
    mockGetDatasetById.mockResolvedValueOnce(mockDataset);
    mockCreateCorrection.mockResolvedValueOnce(mockCorrection);

    await fetch(`${baseUrl}/stat-corrections`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ datasetId: 7, statInstanceId: '7:runway:_:_', note: 'note' }),
    });

    expect(mockRateLimitStatCorrectionTier1Factory).toHaveBeenCalledWith('7:runway:_:_');
  });

  it('does not invoke the Tier 1 rate limiter guard when the dataset lookup 404s', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(ownerPayload());
    mockGetDatasetById.mockResolvedValueOnce(undefined);

    const res = await fetch(`${baseUrl}/stat-corrections`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ datasetId: 999, statInstanceId: '999:runway:_:_', note: 'note' }),
    });

    expect(res.status).toBe(404);
    expect(mockRateLimitStatCorrectionTier1Factory).not.toHaveBeenCalled();
  });

  it('does not invoke the Tier 1 rate limiter guard for a Tier 2 submission', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(ownerPayload());
    mockGetDatasetById.mockResolvedValueOnce(mockDataset);
    mockCreateCorrection.mockResolvedValueOnce({ ...mockCorrection, appliesGoingForward: true, status: 'pending' });

    await fetch(`${baseUrl}/stat-corrections`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        datasetId: 7,
        statInstanceId: '7:runway:_:_',
        note: 'note',
        appliesGoingForward: true,
      }),
    });

    expect(mockRateLimitStatCorrectionTier1Factory).not.toHaveBeenCalled();
  });

  it('returns 429 and skips createCorrection when the Tier 1 guard rate-limits', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(ownerPayload());
    mockGetDatasetById.mockResolvedValueOnce(mockDataset);
    mockRateLimitStatCorrectionTier1Factory.mockImplementationOnce(
      (_statInstanceId: string) => (_req: unknown, res: Response, _next: () => void) => {
        res.set('Retry-After', '120');
        res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Too many requests' } });
      },
    );

    const res = await fetch(`${baseUrl}/stat-corrections`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ datasetId: 7, statInstanceId: '7:runway:_:_', note: 'note' }),
    });
    const json = (await res.json()) as { error: { code: string } };

    expect(res.status).toBe(429);
    expect(json.error.code).toBe('RATE_LIMITED');
    expect(res.headers.get('Retry-After')).toBe('120');
    // guard fires after the dataset lookup (so a 404 doesn't burn quota), but
    // still before the actual row write
    expect(mockGetDatasetById).toHaveBeenCalled();
    expect(mockCreateCorrection).not.toHaveBeenCalled();
  });
});
