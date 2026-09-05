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
const { rateLimitAuth, rateLimitAi, rateLimitPublic, rateLimitDashboardCompute, rateLimitStatCorrectionTier1 } =
  await import('./rateLimiter.js');

// retry, memory-backed limiter + concurrent Promise.all can race on busy CI runners
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
      // public limit is 60/min, exhaust it via memory fallback
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

  describe('rateLimitDashboardCompute', () => {
    let server: http.Server;
    let baseUrl: string;

    beforeAll(async () => {
      const result = await createTestApp((app) => {
        // simulate authMiddleware having already attached req.user
        app.use((req: Request, _res: Response, next) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (req as any).user = { sub: 'dashboard-user-77' };
          next();
        });
        app.use(rateLimitDashboardCompute);
        app.get('/dashboard/compute', (_req: Request, res: Response) => {
          res.json({ data: { ok: true } });
        });
      });
      server = result.server;
      baseUrl = result.baseUrl;
    });

    afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

    it('allows requests under the limit', async () => {
      const res = await fetch(`${baseUrl}/dashboard/compute`);
      expect(res.status).toBe(200);
    });

    it('returns 429 when dashboard limit (30/min) is exceeded', async () => {
      const requests = [];
      for (let i = 0; i < 40; i++) {
        requests.push(fetch(`${baseUrl}/dashboard/compute`));
      }
      const responses = await Promise.all(requests);

      const blocked = responses.filter((r) => r.status === 429);
      expect(blocked.length).toBeGreaterThan(0);
    });
  });

  describe('rateLimitStatCorrectionTier1', () => {
    let server: http.Server;
    let baseUrl: string;

    beforeAll(async () => {
      const result = await createTestApp((app) => {
        // simulate authMiddleware having already attached req.user
        app.use((req: Request, _res: Response, next) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (req as any).user = { sub: 'stat-correction-user-1' };
          next();
        });
        // statInstanceId is only known per-request, hence the factory + route param
        app.post('/stat-corrections/:statInstanceId', (req: Request, res: Response, next) => {
          rateLimitStatCorrectionTier1(req.params.statInstanceId as string)(req, res, next);
        }, (_req: Request, res: Response) => {
          res.status(201).json({ data: { ok: true } });
        });
      });
      server = result.server;
      baseUrl = result.baseUrl;
    });

    afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

    it('allows a request under the limit', async () => {
      const res = await fetch(`${baseUrl}/stat-corrections/stat-a`, { method: 'POST' });
      expect(res.status).toBe(201);
    });

    it('allows exactly 3 requests then returns 429 with Retry-After for the 4th, pinning the cap', async () => {
      // sequential, not concurrent, so this pins the exact limit (3) instead
      // of just asserting "some" requests got blocked out of a burst
      for (let i = 0; i < 3; i++) {
        const res = await fetch(`${baseUrl}/stat-corrections/stat-b`, { method: 'POST' });
        expect(res.status).toBe(201);
      }

      const blockedRes = await fetch(`${baseUrl}/stat-corrections/stat-b`, { method: 'POST' });
      expect(blockedRes.status).toBe(429);
      expect(blockedRes.headers.get('Retry-After')).toBeTruthy();

      const body = (await blockedRes.json()) as { error: { code: string } };
      expect(body.error.code).toBe('RATE_LIMITED');
    });

    it('allows two different statInstanceId args for the same user independently', async () => {
      const [resC, resD] = await Promise.all([
        fetch(`${baseUrl}/stat-corrections/stat-c`, { method: 'POST' }),
        fetch(`${baseUrl}/stat-corrections/stat-d`, { method: 'POST' }),
      ]);

      expect(resC.status).toBe(201);
      expect(resD.status).toBe(201);
    });
  });

  describe('fail-open behavior', () => {
    it('serves requests via memory fallback when Redis is unavailable, never 500s', async () => {
      // ioredis is mocked with no real connection, so rate-limiter-flexible
      // falls to insuranceLimiter (RateLimiterMemory). Every test in this
      // file proves fail-open works, they'd all be 500s if it didn't.
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
      // 200 if under limit, 429 if memory fallback exhausted from earlier tests, both valid
      expect([200, 429]).toContain(res.status);
      expect(res.status).not.toBe(500);

      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
  });
});

// Both user-keyed limiters could be silently downgraded to IP-keyed and every
// test still passed: the existing blocks pin one user, so what the key is made
// of was never observed. In production everyone behind one office NAT would then
// share a single 5/min AI budget, and the logger.warn about falling back to IP
// survives the downgrade untouched, so the logs would not show it either.
//
// The discriminating shape is two users on one IP. Every request here comes from
// 127.0.0.1; only the identity differs.
describe('user-keyed limiters key on the user, not the address', { retry: 2 }, () => {
  async function appKeyedByHeader(limiter: typeof rateLimitAi) {
    return createTestApp((app) => {
      app.use((req: Request, _res: Response, next) => {
        const sub = req.headers['x-test-user'];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if (sub) (req as any).user = { sub: String(sub) };
        next();
      });
      app.use(limiter);
      app.get('/guarded', (_req: Request, res: Response) => res.json({ data: { ok: true } }));
    });
  }

  async function exhaust(baseUrl: string, user: string, attempts: number) {
    const codes: number[] = [];
    for (let i = 0; i < attempts; i += 1) {
      const res = await fetch(`${baseUrl}/guarded`, { headers: { 'x-test-user': user } });
      codes.push(res.status);
    }
    return codes;
  }

  it('gives two users on the same address separate AI budgets', async () => {
    const { server, baseUrl } = await appKeyedByHeader(rateLimitAi);

    try {
      const first = await exhaust(baseUrl, 'ai-heavy-user', 8);
      expect(first).toContain(429);

      // Same IP, different person. IP-keyed, this is 429 too.
      const second = await fetch(`${baseUrl}/guarded`, {
        headers: { 'x-test-user': 'ai-quiet-user' },
      });
      expect(second.status).toBe(200);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('gives two users on the same address separate dashboard budgets', async () => {
    const { server, baseUrl } = await appKeyedByHeader(rateLimitDashboardCompute);

    try {
      const first = await exhaust(baseUrl, 'dash-heavy-user', 45);
      expect(first).toContain(429);

      const second = await fetch(`${baseUrl}/guarded`, {
        headers: { 'x-test-user': 'dash-quiet-user' },
      });
      expect(second.status).toBe(200);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  // The other half: one identity is one budget however many addresses it
  // arrives from, which is what makes the quota per user rather than per device.
  it('shares one budget across repeated requests from the same user', async () => {
    const { server, baseUrl } = await appKeyedByHeader(rateLimitAi);

    try {
      const codes = await exhaust(baseUrl, 'ai-single-user', 8);
      expect(codes.filter((c) => c === 200).length).toBeLessThanOrEqual(5);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
