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
  });
});

vi.mock('../lib/db.js', () => ({
  db: { execute: vi.fn(async () => [{ ok: 1 }]) },
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

beforeEach(() => resetEmailProvider());

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
    expect(body.status).toBe('ok'); // fail-open — email unregistered does not degrade the overall check
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
