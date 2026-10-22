import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';

// Deliberately not createTestApp: that pulls in errorHandler, which imports
// config.ts, which throws at module load without the full env block. req.ip
// depends on nothing but the trust proxy setting, so a bare app is both
// sufficient and honest about what is under test.

// req.ip is what every IP-keyed rate limiter buckets on, so the hop count is a
// security setting, not a formatting one. Too low and one spoofable header
// hands a caller unlimited buckets; too high and the whole app shares a single
// one, which is what shipped: bff-proxy.ts forwarded only the Cookie header, so
// Express never saw an X-Forwarded-For, the address list had one entry, and
// req.ip was the web container for every authenticated request.
//
// The test this replaced asserted that index.ts *contained the string*
// "trust proxy', 2". It passed throughout.
let server: http.Server;
let baseUrl: string;

// Read out of index.ts rather than written here. A literal would make this file
// assert the behaviour of the number 1 instead of the behaviour of the number the
// app actually configures, and changing index.ts would leave it green.
function configuredHops(): number {
  const src = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
  const m = src.match(/app\.set\('trust proxy',\s*(\d+)\)/);
  if (!m) throw new Error('index.ts no longer sets trust proxy to a literal number');
  return Number(m[1]);
}

beforeAll(async () => {
  const app = express();
  app.set('trust proxy', configuredHops());
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

describe('trust proxy hop count', () => {
  it('reads the real caller Caddy appended, not the socket', async () => {
    // One proxy in front, so one entry: Caddy appends the peer it accepted from.
    expect(await ipFor('203.0.113.7')).toBe('203.0.113.7');
  });

  it('ignores an address the caller put in front of their own', async () => {
    // A caller sending X-Forwarded-For: 9.9.9.9 gets Caddy's append after it.
    // Trusting one hop lands on the appended value; trusting two would hand the
    // caller a fresh rate-limit bucket per spoofed address.
    expect(await ipFor('9.9.9.9, 203.0.113.7')).toBe('203.0.113.7');
  });

  it('ignores a whole chain of spoofed addresses', async () => {
    expect(await ipFor('1.1.1.1, 2.2.2.2, 3.3.3.3, 203.0.113.7')).toBe('203.0.113.7');
  });

  it('falls back to the socket when nothing is forwarded, as in local compose', async () => {
    const ip = await ipFor();
    expect(ip).toMatch(/127\.0\.0\.1$/);
  });

  it('gives two callers behind the same proxy different values', async () => {
    // The property the rate limiter actually depends on. With the header
    // dropped these were identical, which is the whole defect.
    const a = await ipFor('198.51.100.1');
    const b = await ipFor('198.51.100.2');
    expect(a).not.toBe(b);
  });
});
