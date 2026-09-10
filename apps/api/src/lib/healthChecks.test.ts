import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.hoisted(() => {
  Object.assign(process.env, {
    DATABASE_URL: 'postgres://u:p@localhost:5432/db',
    DATABASE_ADMIN_URL: 'postgres://u:p@localhost:5432/db',
    REDIS_URL: 'redis://localhost:6379',
    CLAUDE_API_KEY: 'sk-ant-test',
    STRIPE_SECRET_KEY: 'sk_test_x',
    STRIPE_WEBHOOK_SECRET: 'whsec_x',
    STRIPE_PRICE_ID: 'price_x',
    GOOGLE_CLIENT_ID: 'gci',
    GOOGLE_CLIENT_SECRET: 'gcs',
    JWT_SECRET: 'j'.repeat(32),
    APP_URL: 'http://localhost:3000',
    NODE_ENV: 'development',
    EMAIL_FROM_ADDRESS: 'insights@kiln.test.local',
    EMAIL_MAILING_ADDRESS: '500 Test Ave, Denver, CO 80202',
  });
});

// Both checkers live in different modules but share one failure mode, so they
// share a file. dbHealth.integration.test.ts covers the happy path and the
// missing-table path against real Postgres; neither it nor health.test.ts can
// reach these catch blocks, because the route tests mock the checkers outright.
//
// The gap that leaves: changing either catch to return { status: 'ok' } passes
// the entire suite, and /health then answers 200 {status:"ok"} with the database
// and Redis both unreachable. That endpoint is what the production CloudWatch
// alarm polls, so a health check that cannot fail is worse than none.

const mockExecute = vi.hoisted(() => vi.fn());
const mockPing = vi.hoisted(() => vi.fn());

vi.mock('postgres', () => ({ default: vi.fn(() => ({})) }));
vi.mock('drizzle-orm/postgres-js', () => ({
  drizzle: vi.fn(() => ({ execute: mockExecute })),
}));
vi.mock('ioredis', () => ({
  default: vi.fn(() => ({ ping: mockPing, on: vi.fn(), status: 'ready' })),
}));
vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() },
}));

const { checkDatabaseHealth } = await import('./db.js');
const { checkRedisHealth } = await import('./redis.js');

const ALL_PRESENT = [{ users: true, orgs: true, user_orgs: true, datasets: true, data_rows: true }];

beforeEach(() => {
  mockExecute.mockReset();
  mockPing.mockReset();
});

describe('checkDatabaseHealth when the database is unreachable', () => {
  it('reports error with a connection reason, not ok', async () => {
    mockExecute.mockRejectedValueOnce(new Error('ECONNREFUSED 127.0.0.1:5432'));

    const health = await checkDatabaseHealth();

    expect(health.status).toBe('error');
    expect(health.reason).toBe('connection');
  });

  it('distinguishes a connection failure from a missing table', async () => {
    mockExecute.mockResolvedValueOnce([
      { users: true, orgs: true, user_orgs: true, datasets: false, data_rows: true },
    ]);

    const health = await checkDatabaseHealth();

    expect(health.status).toBe('error');
    expect(health.reason).toBe('schema');
    expect(health.missing).toEqual(['datasets']);
  });

  it('reports ok when every required table is present', async () => {
    mockExecute.mockResolvedValueOnce(ALL_PRESENT);

    expect((await checkDatabaseHealth()).status).toBe('ok');
  });

  // An empty result set is what a permission failure looks like, and it must not
  // be read as "no missing tables".
  it('reports error when the query returns no rows at all', async () => {
    mockExecute.mockResolvedValueOnce([]);

    const health = await checkDatabaseHealth();

    expect(health.status).toBe('error');
    expect(health.reason).toBe('schema');
  });

  it('still reports a latency on the failure path', async () => {
    mockExecute.mockRejectedValueOnce(new Error('down'));

    expect((await checkDatabaseHealth()).latencyMs).toBeGreaterThanOrEqual(0);
  });
});

describe('checkRedisHealth when Redis is unreachable', () => {
  it('reports error, not ok', async () => {
    mockPing.mockRejectedValueOnce(new Error('Connection is closed'));

    expect((await checkRedisHealth()).status).toBe('error');
  });

  it('reports ok when the ping succeeds', async () => {
    mockPing.mockResolvedValueOnce('PONG');

    expect((await checkRedisHealth()).status).toBe('ok');
  });

  it('still reports a latency on the failure path', async () => {
    mockPing.mockRejectedValueOnce(new Error('down'));

    expect((await checkRedisHealth()).latencyMs).toBeGreaterThanOrEqual(0);
  });
});
