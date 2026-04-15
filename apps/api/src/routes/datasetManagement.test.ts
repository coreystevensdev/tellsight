import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';

const mockVerifyAccessToken = vi.fn();

vi.mock('../services/auth/tokenService.js', () => ({
  verifyAccessToken: mockVerifyAccessToken,
}));

const mockGetDatasetListWithCounts = vi.fn();
const mockGetDatasetWithCounts = vi.fn();
const mockGetDatasetById = vi.fn();
const mockUpdateDatasetName = vi.fn();
const mockDeleteDataset = vi.fn();
const mockGetDatasetsByOrg = vi.fn();
const mockGetActiveDatasetId = vi.fn();
const mockSetActiveDataset = vi.fn();

vi.mock('../db/queries/index.js', () => ({
  datasetsQueries: {
    getDatasetListWithCounts: (...args: unknown[]) => mockGetDatasetListWithCounts(...args),
    getDatasetWithCounts: (...args: unknown[]) => mockGetDatasetWithCounts(...args),
    getDatasetById: (...args: unknown[]) => mockGetDatasetById(...args),
    updateDatasetName: (...args: unknown[]) => mockUpdateDatasetName(...args),
    deleteDataset: (...args: unknown[]) => mockDeleteDataset(...args),
    getDatasetsByOrg: (...args: unknown[]) => mockGetDatasetsByOrg(...args),
  },
  orgsQueries: {
    getActiveDatasetId: (...args: unknown[]) => mockGetActiveDatasetId(...args),
    setActiveDataset: (...args: unknown[]) => mockSetActiveDataset(...args),
  },
}));

const mockTrackEvent = vi.fn();

vi.mock('../services/analytics/trackEvent.js', () => ({
  trackEvent: mockTrackEvent,
}));

const mockWithRlsContext = vi.fn();

vi.mock('../lib/rls.js', () => ({
  withRlsContext: (...args: unknown[]) => mockWithRlsContext(...args),
}));

vi.mock('../lib/db.js', () => ({
  db: {},
  dbAdmin: { _tag: 'dbAdmin' },
}));

vi.mock('../config.js', () => ({
  env: {
    NODE_ENV: 'test',
    JWT_SECRET: 'test-secret-that-is-at-least-32-characters-long',
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

vi.mock('../middleware/rateLimiter.js', () => ({
  rateLimitPublic: (_req: unknown, _res: unknown, next: () => void) => next(),
  rateLimitAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
  rateLimitAi: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

const { createTestApp } = await import('../test/helpers/testApp.js');
const { authMiddleware } = await import('../middleware/authMiddleware.js');
const { datasetManagementRouter } = await import('./datasetManagement.js');

const ownerPayload = { sub: '1', org_id: 1, role: 'owner' as const, isAdmin: false, iat: 0, exp: 0 };
const memberPayload = { sub: '2', org_id: 1, role: 'member' as const, isAdmin: false, iat: 0, exp: 0 };

const authCookie = { Cookie: 'access_token=valid-token' };

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  const result = await createTestApp((app) => {
    app.use(authMiddleware);
    app.use('/datasets', datasetManagementRouter);
  });
  server = result.server;
  baseUrl = result.baseUrl;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

beforeEach(() => {
  vi.clearAllMocks();
  // execute the callback with a mock transaction object
  mockWithRlsContext.mockImplementation((_orgId: unknown, _isAdmin: unknown, fn: (tx: unknown) => unknown) => fn('mock-tx'));
});

describe('GET /datasets/manage', () => {
  it('returns dataset list for authenticated user', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(ownerPayload);
    mockGetActiveDatasetId.mockResolvedValueOnce(5);
    mockGetDatasetListWithCounts.mockResolvedValueOnce([
      { id: 5, name: 'Q1 2025', rowCount: 120, isActive: true },
      { id: 3, name: 'Q4 2024', rowCount: 88, isActive: false },
    ]);

    const res = await fetch(`${baseUrl}/datasets/manage`, { headers: authCookie });
    const body = await res.json() as { data: unknown[] };

    expect(res.status).toBe(200);
    expect(body.data).toHaveLength(2);
    expect(mockGetActiveDatasetId).toHaveBeenCalledWith(1, 'mock-tx');
    expect(mockGetDatasetListWithCounts).toHaveBeenCalledWith(1, 5, 'mock-tx');
  });
});

describe('GET /datasets/manage/:id', () => {
  it('returns dataset with cascade counts', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(ownerPayload);
    mockGetActiveDatasetId.mockResolvedValueOnce(7);
    mockGetDatasetWithCounts.mockResolvedValueOnce({ id: 7, name: 'Revenue 2025', rowCount: 300, summaryCount: 2, shareCount: 1 });

    const res = await fetch(`${baseUrl}/datasets/manage/7`, { headers: authCookie });
    const body = await res.json() as { data: { id: number; isActive: boolean } };

    expect(res.status).toBe(200);
    expect(body.data.id).toBe(7);
    expect(body.data.isActive).toBe(true);
    expect(mockGetDatasetWithCounts).toHaveBeenCalledWith(1, 7, 'mock-tx');
  });

  it('returns 404 for nonexistent dataset', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(ownerPayload);
    mockGetActiveDatasetId.mockResolvedValueOnce(7);
    mockGetDatasetWithCounts.mockResolvedValueOnce(null);

    const res = await fetch(`${baseUrl}/datasets/manage/99`, { headers: authCookie });
    const body = await res.json() as { error: { code: string } };

    expect(res.status).toBe(404);
    expect(body.error.code).toBe('NOT_FOUND');
  });
});

describe('PATCH /datasets/manage/:id', () => {
  it('renames a dataset', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(ownerPayload);
    mockGetDatasetById.mockResolvedValueOnce({ id: 3, name: 'Old Name', orgId: 1 });
    mockUpdateDatasetName.mockResolvedValueOnce({ id: 3, name: 'New Name', orgId: 1 });

    const res = await fetch(`${baseUrl}/datasets/manage/3`, {
      method: 'PATCH',
      headers: { ...authCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'New Name' }),
    });
    const body = await res.json() as { data: { id: number; name: string } };

    expect(res.status).toBe(200);
    expect(body.data.name).toBe('New Name');
    expect(mockUpdateDatasetName).toHaveBeenCalledWith(1, 3, 'New Name', 'mock-tx');
    expect(mockTrackEvent).toHaveBeenCalledWith(1, 1, expect.any(String), expect.objectContaining({
      datasetId: 3,
      oldName: 'Old Name',
      newName: 'New Name',
    }));
  });

  it('rejects empty name with 400', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(ownerPayload);

    const res = await fetch(`${baseUrl}/datasets/manage/3`, {
      method: 'PATCH',
      headers: { ...authCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '   ' }),
    });
    const body = await res.json() as { error: { code: string } };

    expect(res.status).toBe(400);
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('DELETE /datasets/manage/:id', () => {
  it('allows owner to delete a dataset', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(ownerPayload);
    mockGetDatasetById.mockResolvedValueOnce({ id: 4, name: 'Stale Data', orgId: 1 });
    mockDeleteDataset.mockResolvedValueOnce(undefined);
    // after delete, active is still set to something else
    mockGetActiveDatasetId.mockResolvedValueOnce(5);

    const res = await fetch(`${baseUrl}/datasets/manage/4`, {
      method: 'DELETE',
      headers: authCookie,
    });
    const body = await res.json() as { data: { deleted: boolean; newActiveDatasetId: number } };

    expect(res.status).toBe(200);
    expect(body.data.deleted).toBe(true);
    expect(body.data.newActiveDatasetId).toBe(5);
    expect(mockDeleteDataset).toHaveBeenCalledWith(1, 4, 'mock-tx');
  });

  it('rejects member delete with 403', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(memberPayload);

    const res = await fetch(`${baseUrl}/datasets/manage/4`, {
      method: 'DELETE',
      headers: authCookie,
    });
    const body = await res.json() as { error: { code: string } };

    expect(res.status).toBe(403);
    expect(body.error.code).toBe('FORBIDDEN');
  });

  it('auto-switches active dataset to next newest after delete', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(ownerPayload);
    mockGetDatasetById.mockResolvedValueOnce({ id: 4, name: 'Active Dataset', orgId: 1 });
    mockDeleteDataset.mockResolvedValueOnce(undefined);
    // ON DELETE SET NULL cleared active_dataset_id — it's null now
    mockGetActiveDatasetId.mockResolvedValueOnce(null);
    // remaining datasets — pick the first non-seed one
    mockGetDatasetsByOrg.mockResolvedValueOnce([
      { id: 6, name: 'Next Newest', isSeedData: false },
      { id: 1, name: 'Seed', isSeedData: true },
    ]);
    mockSetActiveDataset.mockResolvedValueOnce(undefined);

    const res = await fetch(`${baseUrl}/datasets/manage/4`, {
      method: 'DELETE',
      headers: authCookie,
    });
    const body = await res.json() as { data: { deleted: boolean; newActiveDatasetId: number } };

    expect(res.status).toBe(200);
    expect(body.data.newActiveDatasetId).toBe(6);
    expect(mockSetActiveDataset).toHaveBeenCalledWith(1, 6, 'mock-tx');
  });
});

describe('POST /datasets/manage/:id/activate', () => {
  it('activates a dataset', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(ownerPayload);
    mockGetDatasetById.mockResolvedValueOnce({ id: 9, name: 'Q2 2025', orgId: 1 });
    mockSetActiveDataset.mockResolvedValueOnce(undefined);

    const res = await fetch(`${baseUrl}/datasets/manage/9/activate`, {
      method: 'POST',
      headers: authCookie,
    });
    const body = await res.json() as { data: { activeDatasetId: number } };

    expect(res.status).toBe(200);
    expect(body.data.activeDatasetId).toBe(9);
    expect(mockSetActiveDataset).toHaveBeenCalledWith(1, 9, 'mock-tx');
    expect(mockTrackEvent).toHaveBeenCalledWith(1, 1, expect.any(String), { datasetId: 9 });
  });

  it('returns 404 for dataset in another org', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(ownerPayload);
    // RLS means getDatasetById returns null for out-of-org datasets
    mockGetDatasetById.mockResolvedValueOnce(null);

    const res = await fetch(`${baseUrl}/datasets/manage/99/activate`, {
      method: 'POST',
      headers: authCookie,
    });
    const body = await res.json() as { error: { code: string } };

    expect(res.status).toBe(404);
    expect(body.error.code).toBe('NOT_FOUND');
  });
});
