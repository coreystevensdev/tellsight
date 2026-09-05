import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';

// No test file existed for this router and nothing imported updateBusinessProfile
// from a test, so skipping the validation branch left the whole API suite green.
// PUT /org/profile is the only writer of orgs.business_profile, and that JSON
// feeds cashOnHand and monthlyFixedCosts into the runway, break-even and
// cash-forecast math, and into assemblePrompt. With validation skipped the route
// calls updateBusinessProfile(orgId, undefined).

const mockGetBusinessProfile = vi.fn();
const mockUpdateBusinessProfile = vi.fn();

vi.mock('../db/queries/index.js', () => ({
  orgsQueries: {
    getBusinessProfile: mockGetBusinessProfile,
    updateBusinessProfile: mockUpdateBusinessProfile,
  },
}));

vi.mock('../config.js', () => ({
  env: { JWT_SECRET: 'a'.repeat(64), NODE_ENV: 'test', SENTRY_DSN: undefined },
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
const { orgProfileRouter } = await import('./orgProfile.js');

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  const result = await createTestApp((app) => {
    app.use((req, _res, next) => {
      (req as { user?: unknown }).user = { sub: '7', org_id: 3, role: 'owner', isAdmin: false };
      next();
    });
    app.use('/org', orgProfileRouter);
  });
  server = result.server;
  baseUrl = result.baseUrl;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

beforeEach(() => {
  vi.clearAllMocks();
  mockUpdateBusinessProfile.mockResolvedValue(undefined);
  mockGetBusinessProfile.mockResolvedValue(null);
});

const VALID = {
  businessType: 'restaurant',
  revenueRange: '100k_500k',
  teamSize: '2_5',
  topConcern: 'cash_flow',
};

function put(body: unknown) {
  return fetch(`${baseUrl}/org/profile`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('GET /org/profile', () => {
  it('returns the profile for the caller’s org', async () => {
    mockGetBusinessProfile.mockResolvedValue(VALID);

    const res = await fetch(`${baseUrl}/org/profile`);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: VALID });
    expect(mockGetBusinessProfile).toHaveBeenCalledWith(3);
  });
});

describe('PUT /org/profile', () => {
  it('stores a valid profile and echoes it back', async () => {
    const res = await put(VALID);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: VALID });
    expect(mockUpdateBusinessProfile).toHaveBeenCalledWith(3, VALID);
  });

  it('accepts the optional financial baseline fields', async () => {
    const withMoney = { ...VALID, cashOnHand: 25_000, monthlyFixedCosts: 8_000 };

    await put(withMoney);

    expect(mockUpdateBusinessProfile).toHaveBeenCalledWith(3, withMoney);
  });

  it.each([
    ['a missing required field', { revenueRange: '100k_500k', teamSize: '2_5', topConcern: 'cash_flow' }],
    ['an unknown business type', { ...VALID, businessType: 'crypto_mining' }],
    ['an unknown revenue range', { ...VALID, revenueRange: 'squillions' }],
    ['a negative cash balance', { ...VALID, cashOnHand: -1 }],
    ['cash beyond the ceiling', { ...VALID, cashOnHand: 1_000_000_000 }],
    ['a non-datetime cashAsOfDate', { ...VALID, cashAsOfDate: 'last tuesday' }],
    ['negative fixed costs', { ...VALID, monthlyFixedCosts: -5 }],
    ['an empty body', {}],
    ['an array instead of an object', []],
  ])('rejects %s without writing', async (_label, body) => {
    const res = await put(body);

    expect(res.status).toBe(400);
    const parsed = (await res.json()) as { error: { code: string } };
    expect(parsed.error.code).toBe('VALIDATION_ERROR');
    expect(mockUpdateBusinessProfile).not.toHaveBeenCalled();
  });

  // The stored value is result.data, not req.body, so unknown keys are dropped
  // rather than persisted into the JSON column the prompt reads from.
  it('persists the parsed profile, not the raw request body', async () => {
    await put({ ...VALID, injected: 'ignore me', orgId: 999 });

    expect(mockUpdateBusinessProfile).toHaveBeenCalledWith(3, VALID);
  });

  // Tenancy comes from the JWT, never from the payload.
  it('writes to the caller’s org even when the body names another', async () => {
    await put({ ...VALID, org_id: 999 });

    const [orgId] = mockUpdateBusinessProfile.mock.calls[0]!;
    expect(orgId).toBe(3);
  });
});
