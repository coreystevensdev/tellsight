import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import { validCsv, missingColumn, emptyFile, mixedCaseHeaders } from '../test/fixtures/csvFiles.js';

const mockVerifyAccessToken = vi.fn();
const mockTrackEvent = vi.fn();
const mockPersistUpload = vi.fn();

vi.mock('../services/auth/tokenService.js', () => ({
  verifyAccessToken: mockVerifyAccessToken,
}));

vi.mock('../services/analytics/trackEvent.js', () => ({
  trackEvent: mockTrackEvent,
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

vi.mock('../db/queries/index.js', () => ({
  datasetsQueries: {
    persistUpload: (...args: unknown[]) => mockPersistUpload(...args),
    getNonSeedDatasetCount: vi.fn().mockResolvedValue(0),
  },
  orgsQueries: {
    setActiveDataset: vi.fn().mockResolvedValue(null),
  },
  subscriptionsQueries: {
    getActiveTier: vi.fn().mockResolvedValue('free'),
  },
  auditLogsQueries: {
    record: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../lib/rls.js', () => ({
  withRlsContext: vi.fn((_orgId: number, _isAdmin: boolean, fn: (tx: unknown) => Promise<unknown>) => fn({})),
}));

const { createTestApp } = await import('../test/helpers/testApp.js');
const { authMiddleware } = await import('../middleware/authMiddleware.js');
const { datasetsRouter } = await import('./datasets.js');

interface PreviewBody {
  data: {
    headers: string[];
    sampleRows: Record<string, string>[];
    rowCount: number;
    validRowCount: number;
    skippedRowCount: number;
    previewToken: string;
    fileName: string;
  };
}

interface ErrorBody {
  error: {
    code: string;
    message: string;
    details: {
      errors: { column: string; message: string }[];
      fileName?: string;
    };
  };
}

interface ConfirmBody {
  data: { datasetId: number; rowCount: number; demoState: string };
}

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  const result = await createTestApp((app) => {
    app.use(authMiddleware);
    app.use('/datasets', datasetsRouter);
  });
  server = result.server;
  baseUrl = result.baseUrl;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

beforeEach(() => vi.clearAllMocks());

function userPayload() {
  return {
    sub: '42',
    org_id: 10,
    role: 'owner',
    isAdmin: false,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 900,
  };
}

const authHeaders = { Cookie: 'access_token=valid-jwt' };

function uploadCsv(csvContent: string, fileName = 'test.csv') {
  const form = new FormData();
  form.append('file', new Blob([csvContent], { type: 'text/csv' }), fileName);
  return fetch(`${baseUrl}/datasets`, {
    method: 'POST',
    body: form,
    headers: authHeaders,
  });
}

function confirmCsv(csvContent: string, fileName = 'test.csv', previewToken?: string) {
  const form = new FormData();
  form.append('file', new Blob([csvContent], { type: 'text/csv' }), fileName);
  if (previewToken) form.append('previewToken', previewToken);
  return fetch(`${baseUrl}/datasets/confirm`, {
    method: 'POST',
    body: form,
    headers: authHeaders,
  });
}

/** Runs a full preview and returns the token for use in confirm tests */
async function getPreviewToken(csvContent: string, fileName = 'test.csv'): Promise<string> {
  mockVerifyAccessToken.mockResolvedValueOnce(userPayload());
  const res = await uploadCsv(csvContent, fileName);
  const body = (await res.json()) as PreviewBody;
  return body.data.previewToken;
}

describe('POST /datasets', () => {
  it('returns 200 with preview data for valid CSV', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(userPayload());

    const res = await uploadCsv(validCsv);
    expect(res.status).toBe(200);

    const body = (await res.json()) as PreviewBody;
    expect(body.data).toBeDefined();
    expect(body.data.headers).toEqual(['date', 'amount', 'category']);
    expect(body.data.sampleRows).toHaveLength(3);
    expect(body.data.rowCount).toBe(3);
    expect(body.data.validRowCount).toBe(3);
    expect(body.data.skippedRowCount).toBe(0);
    expect(body.data.fileName).toBe('test.csv');
  });

  it('includes previewToken in response', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(userPayload());

    const res = await uploadCsv(validCsv);
    const body = (await res.json()) as PreviewBody;

    expect(body.data.previewToken).toBeTruthy();
    expect((body.data as Record<string, unknown>).fileHash).toBeUndefined();
  });

  it('normalizes sample row keys to match headers', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(userPayload());

    const res = await uploadCsv(mixedCaseHeaders);
    expect(res.status).toBe(200);

    const body = (await res.json()) as PreviewBody;
    // Headers are normalized to lowercase
    expect(body.data.headers).toEqual(['date', 'amount', 'category']);
    // Sample row keys should also be lowercase
    const firstRow = body.data.sampleRows[0]!;
    expect(firstRow).toHaveProperty('date', '2025-01-15');
    expect(firstRow).toHaveProperty('amount', '1200.00');
    expect(firstRow).toHaveProperty('category', 'Revenue');
    // Original-cased keys should NOT be present
    expect(firstRow).not.toHaveProperty('Date');
    expect(firstRow).not.toHaveProperty('Amount');
  });

  it('returns 400 for CSV with missing required columns', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(userPayload());

    const res = await uploadCsv(missingColumn);
    expect(res.status).toBe(400);

    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.details.errors[0]!.column).toBe('amount');
    expect(body.error.details.errors[0]!.message).toContain('We expected');
  });

  it('returns 400 for empty file', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(userPayload());

    const res = await uploadCsv(emptyFile);
    expect(res.status).toBe(400);

    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.message).toContain('empty');
  });

  it('returns 401 without auth', async () => {
    const form = new FormData();
    form.append('file', new Blob(['date,amount,category'], { type: 'text/csv' }), 'test.csv');

    const res = await fetch(`${baseUrl}/datasets`, {
      method: 'POST',
      body: form,
    });
    expect(res.status).toBe(401);
  });

  it('calls trackEvent on successful validation', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(userPayload());

    await uploadCsv(validCsv);

    expect(mockTrackEvent).toHaveBeenCalledWith(
      10,
      42,
      'dataset.uploaded',
      expect.objectContaining({ rowCount: 3, fileName: 'test.csv' }),
    );
  });

  it('returns 400 for wrong file type', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(userPayload());

    const form = new FormData();
    form.append('file', new Blob(['not csv'], { type: 'application/json' }), 'data.json');

    const res = await fetch(`${baseUrl}/datasets`, {
      method: 'POST',
      body: form,
      headers: authHeaders,
    });
    expect(res.status).toBe(400);

    const body = (await res.json()) as ErrorBody;
    expect(body.error.message).toContain('expected a .csv file');
  });
});

describe('POST /datasets/confirm', () => {
  beforeEach(() => {
    mockPersistUpload.mockResolvedValue({ datasetId: 7, rowCount: 3, demoState: 'user_only' });
  });

  it('persists data with valid preview token', async () => {
    const token = await getPreviewToken(validCsv);
    mockVerifyAccessToken.mockResolvedValueOnce(userPayload());

    const res = await confirmCsv(validCsv, 'test.csv', token);
    expect(res.status).toBe(200);

    const body = (await res.json()) as ConfirmBody;
    expect(body.data.datasetId).toBe(7);
    expect(body.data.rowCount).toBe(3);
  });

  it('calls persistUpload with correct org, user, filename, and rows', async () => {
    const token = await getPreviewToken(validCsv, 'revenue.csv');
    mockVerifyAccessToken.mockResolvedValueOnce(userPayload());

    await confirmCsv(validCsv, 'revenue.csv', token);

    expect(mockPersistUpload).toHaveBeenCalledWith(
      10,
      42,
      'revenue.csv',
      expect.arrayContaining([
        expect.objectContaining({ category: 'Revenue' }),
      ]),
      expect.anything(),
    );
    expect(mockPersistUpload.mock.calls[0]![3]).toHaveLength(3);
  });

  it('fires trackEvent with dataset.confirmed', async () => {
    const token = await getPreviewToken(validCsv);
    mockVerifyAccessToken.mockResolvedValueOnce(userPayload());

    await confirmCsv(validCsv, 'test.csv', token);

    expect(mockTrackEvent).toHaveBeenCalledWith(
      10,
      42,
      'dataset.confirmed',
      expect.objectContaining({ datasetId: 7, rowCount: 3 }),
    );
  });

  it('includes demoState in confirm response', async () => {
    const token = await getPreviewToken(validCsv);
    mockVerifyAccessToken.mockResolvedValueOnce(userPayload());

    const res = await confirmCsv(validCsv, 'test.csv', token);
    const body = (await res.json()) as ConfirmBody;

    expect(body.data.demoState).toBe('user_only');
  });

  it('rejects when preview token is missing', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(userPayload());

    const res = await confirmCsv(validCsv);
    expect(res.status).toBe(400);

    const body = (await res.json()) as ErrorBody;
    expect(body.error.message).toContain('Missing preview token');
  });

  it('rejects when file changes between preview and confirm', async () => {
    const token = await getPreviewToken(validCsv);
    mockVerifyAccessToken.mockResolvedValueOnce(userPayload());

    // Send a different CSV with the token from the original
    const differentCsv = `date,amount,category\n2025-06-01,9999.99,Fraud`;
    const res = await confirmCsv(differentCsv, 'test.csv', token);
    expect(res.status).toBe(400);

    const body = (await res.json()) as ErrorBody;
    expect(body.error.message).toContain('File has changed since preview');
  });

  it('rejects expired preview token (>30 min)', async () => {
    const token = await getPreviewToken(validCsv);

    // fast-forward past the 30-minute TTL
    const realNow = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(realNow + 31 * 60 * 1000);

    mockVerifyAccessToken.mockResolvedValueOnce(userPayload());

    const res = await confirmCsv(validCsv, 'test.csv', token);
    expect(res.status).toBe(400);

    const body = (await res.json()) as ErrorBody;
    expect(body.error.message).toContain('File has changed since preview');

    vi.restoreAllMocks();
  });

  it('rejects tampered preview token', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(userPayload());

    const res = await confirmCsv(validCsv, 'test.csv', 'not-a-real-token');
    expect(res.status).toBe(400);

    const body = (await res.json()) as ErrorBody;
    expect(body.error.message).toContain('File has changed since preview');
  });

  it('returns 401 without auth', async () => {
    const form = new FormData();
    form.append('file', new Blob([validCsv], { type: 'text/csv' }), 'test.csv');

    const res = await fetch(`${baseUrl}/datasets/confirm`, {
      method: 'POST',
      body: form,
    });
    expect(res.status).toBe(401);
  });
});
