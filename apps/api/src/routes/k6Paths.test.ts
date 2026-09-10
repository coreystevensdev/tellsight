import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';

// authMiddleware answers 401 across the whole protected mount before routing gets
// to run, so with real auth in front a path matching no route is indistinguishable
// from one that does: both come back 401. That is exactly how k6 spent months
// requesting /api/datasets, a path Express never served, and grading the 401 as a
// passing flow. Stubbing auth is what makes the 404 visible.
vi.mock('../middleware/authMiddleware.js', () => ({
  authMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));

// Parsed out of the k6 script rather than listed here, so adding a flow to the
// load test without a route to serve it fails this instead of passing quietly.
function k6Requests() {
  const src = readFileSync(`${repoRoot}k6/load-test.js`, 'utf8');
  const found = [
    ...src.matchAll(/http\.(get|post|put|patch|del)\(\s*`\$\{BASE_URL\}([^`]*)`/g),
  ].map(([, method = '', path = '']) => ({
    method: method === 'del' ? 'DELETE' : method.toUpperCase(),
    // Any interpolation left in the path is an id, and every id in these routes
    // is numeric.
    path: path.replace(/\$\{[^}]+\}/g, '1'),
  }));
  if (found.length === 0) throw new Error('parsed no requests out of k6/load-test.js');
  return found;
}

describe('k6 load test paths', () => {
  let server: Server;
  let baseUrl: string;
  let envBefore: NodeJS.ProcessEnv;

  beforeAll(async () => {
    // The routers pull in config.ts, which validates the whole env and throws at
    // module load. .env.ci is the canonical minimum that boots the app, and is
    // what the Docker Smoke Test runs k6 against.
    //
    // process.env outlives the per-file module registry, so this has to be put
    // back: .env.ci points REDIS_URL at the docker hostname, and leaving that set
    // sent two rateLimiter tests looking for a host named "redis" until they timed
    // out. They passed alone and failed in the full run, which is what an env leak
    // looks like from the outside.
    envBefore = { ...process.env };
    process.loadEnvFile(`${repoRoot}.env.ci`);

    const { createTestApp } = await import('../test/helpers/testApp.js');
    const healthRouter = (await import('./health.js')).default;
    const dashboardRouter = (await import('./dashboard.js')).default;
    const protectedRouter = (await import('./protected.js')).default;

    ({ server, baseUrl } = await createTestApp((app) => {
      app.use(healthRouter);
      app.use(dashboardRouter);
      app.use(protectedRouter);
      // Stands in for index.ts's 404. A router that serves a k6 path but is not
      // mounted here fails loudly rather than passing, which is the safe
      // direction: the fix is to mount it.
      app.use((_req, res) => res.status(404).json({ error: { code: 'NOT_ROUTED' } }));
    }));
  }, 30_000);

  afterAll(() => {
    server?.close();
    for (const k of Object.keys(process.env)) if (!(k in envBefore)) delete process.env[k];
    Object.assign(process.env, envBefore);
  });

  it('parses the requests the script actually makes', () => {
    const paths = k6Requests().map((r) => `${r.method} ${r.path}`);
    expect(paths).toContain('GET /health');
    expect(paths).toContain('POST /datasets');
  });

  it.each(k6Requests())('routes $method $path', async ({ method, path }) => {
    const res = await fetch(`${baseUrl}${path}`, { method });
    // Not a 200: these handlers reach for a database this suite does not have, so
    // a 500 is expected and irrelevant. The only question is whether Express
    // matched the path at all.
    expect(res.status, `${method} ${path} matched no route`).not.toBe(404);
  });

  it('would catch the prefix bug it was written for', async () => {
    const res = await fetch(`${baseUrl}/api/datasets`);
    expect(res.status).toBe(404);
  });
});
