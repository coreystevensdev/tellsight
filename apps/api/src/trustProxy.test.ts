import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';

// Deliberately not createTestApp: that pulls in errorHandler, which imports
// config.ts, which throws at module load without the full env block. req.ip
// depends on nothing but the trust proxy setting, so a bare app is both
// sufficient and honest about what is under test.

// req.ip is what every IP-keyed rate limiter buckets on, so this is a security
// setting. Two earlier attempts were both wrong, and both had a green test:
// a hop count of 2 left apiServer's forwarded chain spoofable, and 1 put every
// browser fetch into a single bucket keyed on Caddy's container address.
let server: http.Server;
let baseUrl: string;

// Read out of index.ts rather than written here. A literal would make this file
// assert the behaviour of some setting index.ts does not use, and changing
// index.ts would leave it green.
function configuredTrust(): string {
  const src = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
  const m = src.match(/app\.set\('trust proxy', '([^']+)'\)/);
  if (!m) throw new Error('index.ts no longer sets trust proxy to a literal string');
  return m[1]!;
}

beforeAll(async () => {
  const app = express();
  app.set('trust proxy', configuredTrust());
  app.get('/whoami', (req, res) => {
    res.json({ ip: req.ip });
  });

  server = await new Promise<http.Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

async function ipFor(forwardedFor?: string): Promise<string> {
  const res = await fetch(`${baseUrl}/whoami`, {
    headers: forwardedFor ? { 'x-forwarded-for': forwardedFor } : {},
  });
  return ((await res.json()) as { ip: string }).ip;
}

const CALLER = '203.0.113.7';
// Caddy and the web app as the other sees them on the compose bridge.
const EDGE = '172.18.0.4';
const WEB = '172.18.0.5';

describe('trust proxy resolves the caller at either depth', () => {
  // apiServer hand-builds its fetch and appends nothing, so Caddy's entry is
  // last. This is the shallower of the two paths.
  it('reads the caller on a server-rendered page request', async () => {
    expect(await ipFor(CALLER)).toBe(CALLER);
  });

  // A browser fetch to /api/* picks up a second append from the Next.js rewrite.
  it('reads the caller on a browser fetch through the rewrite', async () => {
    expect(await ipFor(`${CALLER}, ${EDGE}`)).toBe(CALLER);
  });

  it('still reads the caller if another private hop is ever added', async () => {
    expect(await ipFor(`${CALLER}, ${EDGE}, ${WEB}`)).toBe(CALLER);
  });
});

describe('trust proxy ignores what the caller prepends', () => {
  it.each([
    ['one', '9.9.9.9'],
    ['two', '1.1.1.1, 2.2.2.2'],
    ['three', '1.1.1.1, 2.2.2.2, 3.3.3.3'],
  ])('ignores %s prepended addresses on the shallow path', async (_n, spoof) => {
    expect(await ipFor(`${spoof}, ${CALLER}`)).toBe(CALLER);
  });

  it('ignores prepended addresses through the rewrite too', async () => {
    expect(await ipFor(`1.2.3.4, ${CALLER}, ${EDGE}`)).toBe(CALLER);
  });

  // A private address would extend trust if it were reached, but it sits further
  // out than the public entry Caddy appended, so the walk stops first.
  it('is not fooled by a prepended private address', async () => {
    expect(await ipFor(`10.0.0.9, ${CALLER}, ${EDGE}`)).toBe(CALLER);
  });
});

describe('trust proxy edge cases', () => {
  // The production log that started this read ip: "::ffff:172.18.0.5", so the
  // bridge addresses arrive v4-mapped and the trust list has to match them.
  it('treats a v4-mapped private hop as private', async () => {
    expect(await ipFor(`${CALLER}, ::ffff:${EDGE}`)).toBe(CALLER);
  });

  it('falls back to the socket when nothing is forwarded, as in local compose', async () => {
    expect(await ipFor()).toMatch(/127\.0\.0\.1$/);
  });

  it('gives two callers behind the same proxy different values', async () => {
    const a = await ipFor(`198.51.100.1, ${EDGE}`);
    const b = await ipFor(`198.51.100.2, ${EDGE}`);
    expect(a).not.toBe(b);
  });
});
