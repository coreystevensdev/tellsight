import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';

vi.hoisted(() => {
  Object.assign(process.env, {
    DATABASE_URL: 'postgres://u:p@localhost:5432/db',
    DATABASE_ADMIN_URL: 'postgres://u:p@localhost:5432/db',
    REDIS_URL: 'redis://localhost:6379',
    CLAUDE_API_KEY: 'sk-ant-test',
    STRIPE_SECRET_KEY: 'sk_live_x',
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

// The query itself is covered against real Postgres in db.integration.test.ts.
// These pin what the route does with the answer.
const mockCheckDatabaseHealth = vi.hoisted(() => vi.fn());

vi.mock('../lib/db.js', () => ({
  db: { execute: vi.fn() },
  checkDatabaseHealth: mockCheckDatabaseHealth,
}));

vi.mock('../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() },
}));

vi.mock('../lib/redis.js', () => ({
  checkRedisHealth: vi.fn(async () => ({ status: 'ok', latencyMs: 1 })),
}));

import { createTestApp } from '../test/helpers/testApp.js';
import healthRouter from './health.js';
import { env } from '../config.js';
import { createConsoleProvider } from '../services/email/providers/console.js';
import { registerEmailProvider, resetEmailProvider } from '../services/email/index.js';

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  const result = await createTestApp((app) => {
    app.use(healthRouter);
  });
  server = result.server;
  baseUrl = result.baseUrl;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

beforeEach(() => {
  resetEmailProvider();
  mockCheckDatabaseHealth.mockReset();
  mockCheckDatabaseHealth.mockResolvedValue({ status: 'ok', latencyMs: 1 });
});

describe('GET /health', () => {
  it('includes email: { provider, status, latencyMs } when console is registered', async () => {
    registerEmailProvider(createConsoleProvider(env));

    const res = await fetch(`${baseUrl}/health`);
    const body = (await res.json()) as {
      services: {
        email: { provider: string; status: string; latencyMs: number };
      };
    };

    expect(res.status).toBe(200);
    expect(body.services.email).toEqual({
      provider: 'console',
      status: 'ok',
      latencyMs: 0,
    });
  });

  it('surfaces "unregistered" when no provider has been registered', async () => {
    const res = await fetch(`${baseUrl}/health`);
    const body = (await res.json()) as {
      status: string;
      services: { email: { provider: string; status: string; latencyMs: number } };
    };

    expect(res.status).toBe(200);
    expect(body.status).toBe('ok'); // fail-open, email unregistered does not degrade the overall check
    expect(body.services.email).toEqual({
      provider: 'none',
      status: 'unregistered',
      latencyMs: 0,
    });
  });
});

describe('GET /health/ready', () => {
  it('includes email payload alongside database + redis', async () => {
    registerEmailProvider(createConsoleProvider(env));

    const res = await fetch(`${baseUrl}/health/ready`);
    const body = (await res.json()) as {
      services: {
        database: { status: string };
        redis: { status: string };
        email: { provider: string; status: string; latencyMs: number };
      };
    };

    expect(res.status).toBe(200);
    expect(body.services.database.status).toBe('ok');
    expect(body.services.redis.status).toBe('ok');
    expect(body.services.email).toEqual({
      provider: 'console',
      status: 'ok',
      latencyMs: 0,
    });
  });
});

// SELECT 1 passed against a database with no tables, so a dev container once
// reported ready and then 500ed on every request. These pin the difference.
describe('GET /health/ready schema awareness', () => {
  it('is ready when every required table is there', async () => {
    const res = await fetch(`${baseUrl}/health/ready`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.services.database).toMatchObject({ status: 'ok' });
    expect(body.services.database.reason).toBeUndefined();
  });

  it('is not ready when a required table is missing', async () => {
    mockCheckDatabaseHealth.mockResolvedValue({
      status: 'error',
      reason: 'schema',
      missing: ['data_rows'],
      latencyMs: 2,
    });

    const res = await fetch(`${baseUrl}/health/ready`);
    const body = await res.json();

    expect(res.status).toBe(503);
    expect(body.status).toBe('degraded');
    expect(body.services.database).toMatchObject({ status: 'error', reason: 'schema' });
  });

  it('is not ready against a database with nothing in it', async () => {
    mockCheckDatabaseHealth.mockResolvedValue({
      status: 'error',
      reason: 'schema',
      missing: ['users', 'orgs', 'user_orgs', 'datasets', 'data_rows'],
      latencyMs: 2,
    });

    const res = await fetch(`${baseUrl}/health/ready`);

    expect(res.status).toBe(503);
  });

  it('separates a connection failure from a schema one', async () => {
    mockCheckDatabaseHealth.mockResolvedValue({
      status: 'error',
      reason: 'connection',
      latencyMs: 75,
    });

    const res = await fetch(`${baseUrl}/health/ready`);
    const body = await res.json();

    expect(res.status).toBe(503);
    expect(body.services.database).toMatchObject({ status: 'error', reason: 'connection' });
  });

  // The endpoint is public, so the table names belong in the log and nowhere else.
  it('does not name the missing tables in the response', async () => {
    mockCheckDatabaseHealth.mockResolvedValue({
      status: 'error',
      reason: 'schema',
      missing: ['users'],
      latencyMs: 2,
    });

    const res = await fetch(`${baseUrl}/health/ready`);

    expect(JSON.stringify(await res.json())).not.toContain('users');
  });

  // Liveness restarts containers. Restarting cannot create a table, so a schema
  // problem must not look like a dead process.
  it('leaves liveness alone when the schema is incomplete', async () => {
    mockCheckDatabaseHealth.mockResolvedValue({
      status: 'error',
      reason: 'schema',
      missing: ['users'],
      latencyMs: 2,
    });

    const res = await fetch(`${baseUrl}/health/live`);

    expect(res.status).toBe(200);
  });
});
