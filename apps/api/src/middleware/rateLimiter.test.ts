import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type { Request, Response } from 'express';

vi.mock('../config.js', () => ({
  env: { NODE_ENV: 'test', REDIS_URL: 'redis://localhost:6379' },
}));

vi.mock('../lib/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnValue({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  },
}));

// mock ioredis so we don't need a real Redis connection
vi.mock('ioredis', () => {
  const RedisMock = vi.fn().mockImplementation(() => ({
    status: 'ready',
    on: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
  }));
  return { default: RedisMock };
});

const { createTestApp } = await import('../test/helpers/testApp.js');

// rate-limiter-flexible with mocked Redis will fall through to insurance (memory) limiter
const { rateLimitAuth, rateLimitAi, rateLimitPublic } = await import('./rateLimiter.js');

// retry — memory-backed limiter + concurrent Promise.all can race on busy CI runners
describe('rateLimiter', { retry: 2 }, () => {
  describe('rateLimitPublic', () => {
    let server: http.Server;
    let baseUrl: string;

    beforeAll(async () => {
      const result = await createTestApp((app) => {
        app.use(rateLimitPublic);
        app.get('/public', (_req: Request, res: Response) => {
          res.json({ data: { ok: true } });
        });
      });
      server = result.server;
      baseUrl = result.baseUrl;
    });

    afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

    it('allows requests under the limit', async () => {
      const res = await fetch(`${baseUrl}/public`);
      expect(res.status).toBe(200);
    });

    it('returns 429 with Retry-After when limit is exceeded', async () => {
      // public limit is 60/min — exhaust it via memory fallback
      const requests = [];
      for (let i = 0; i < 65; i++) {
        requests.push(fetch(`${baseUrl}/public`));
      }
      const responses = await Promise.all(requests);

      const blocked = responses.filter((r) => r.status === 429);
      expect(blocked.length).toBeGreaterThan(0);

      const blockedRes = blocked[0]!;
      expect(blockedRes.headers.get('Retry-After')).toBeTruthy();

      const body = (await blockedRes.json()) as { error: { code: string } };
      expect(body.error.code).toBe('RATE_LIMITED');
    });
  });

  describe('rateLimitAuth', () => {
    let server: http.Server;
    let baseUrl: string;

    beforeAll(async () => {
      const result = await createTestApp((app) => {
        app.use(rateLimitAuth);
        app.post('/auth/test', (_req: Request, res: Response) => {
          res.json({ data: { ok: true } });
        });
      });
      server = result.server;
      baseUrl = result.baseUrl;
    });

    afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

    it('allows requests under the limit', async () => {
      const res = await fetch(`${baseUrl}/auth/test`, { method: 'POST' });
      expect(res.status).toBe(200);
    });

    it('returns 429 when auth limit (10/min) is exceeded', async () => {
      const requests = [];
      for (let i = 0; i < 15; i++) {
        requests.push(fetch(`${baseUrl}/auth/test`, { method: 'POST' }));
      }
      const responses = await Promise.all(requests);

      const blocked = responses.filter((r) => r.status === 429);
      expect(blocked.length).toBeGreaterThan(0);
    });
  });

  describe('rateLimitAi', () => {
    let server: http.Server;
    let baseUrl: string;

    beforeAll(async () => {
      const result = await createTestApp((app) => {
        // simulate authMiddleware having already attached req.user
        app.use((req: Request, _res: Response, next) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (req as any).user = { sub: 'user-99' };
          next();
        });
        app.use(rateLimitAi);
        app.get('/ai/summary', (_req: Request, res: Response) => {
          res.json({ data: { ok: true } });
        });
      });
      server = result.server;
      baseUrl = result.baseUrl;
    });

    afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

    it('allows requests under the limit', async () => {
      const res = await fetch(`${baseUrl}/ai/summary`);
      expect(res.status).toBe(200);
    });

    it('returns 429 when AI limit (5/min) is exceeded', async () => {
      const requests = [];
      for (let i = 0; i < 10; i++) {
        requests.push(fetch(`${baseUrl}/ai/summary`));
      }
      const responses = await Promise.all(requests);

      const blocked = responses.filter((r) => r.status === 429);
      expect(blocked.length).toBeGreaterThan(0);
    });
  });

  describe('fail-open behavior', () => {
    it('serves requests via memory fallback when Redis is unavailable — never 500s', async () => {
      // ioredis is mocked with no real connection, so rate-limiter-flexible
      // falls to insuranceLimiter (RateLimiterMemory). Every test in this
      // file proves fail-open works — they'd all be 500s if it didn't.
      //
      // This test explicitly asserts the response is a valid rate-limiter
      // response (200 or 429), never a 500 or connection timeout.
      const result = await createTestApp((app) => {
        app.use(rateLimitPublic);
        app.get('/health-check', (_req: Request, res: Response) => {
          res.json({ data: { healthy: true } });
        });
      });
      const server = result.server;

      const res = await fetch(`${result.baseUrl}/health-check`);
      // 200 if under limit, 429 if memory fallback exhausted from earlier tests — both valid
      expect([200, 429]).toContain(res.status);
      expect(res.status).not.toBe(500);

      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
  });
});
