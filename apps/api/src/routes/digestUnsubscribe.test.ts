import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';

// This router had no test file and nothing in the repo imported it, so the
// branch that turns a forged or tampered token into a 400 was unexercised.
// unsubscribeToken.ts has its own verifier test; the route's use of it did not.

const mockUpsertDefaults = vi.fn();
const mockMarkUnsubscribed = vi.fn();

vi.mock('../db/queries/index.js', () => ({
  digestPreferencesQueries: {
    upsertDefaults: mockUpsertDefaults,
    markUnsubscribed: mockMarkUnsubscribed,
  },
}));

vi.mock('../lib/db.js', () => ({ dbAdmin: { __admin: true } }));
vi.mock('../config.js', () => ({ env: { JWT_SECRET: 'a'.repeat(64), NODE_ENV: 'test' } }));
vi.mock('../lib/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnValue({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  },
}));

const { createTestApp } = await import('../test/helpers/testApp.js');
const { signUnsubscribeToken } = await import('../jobs/digest/unsubscribeToken.js');
const { publicDigestUnsubscribeRouter } = await import('./digestUnsubscribe.js');

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  const result = await createTestApp((app) => {
    app.use(publicDigestUnsubscribeRouter);
  });
  server = result.server;
  baseUrl = result.baseUrl;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

beforeEach(() => {
  vi.clearAllMocks();
  mockUpsertDefaults.mockResolvedValue(undefined);
  mockMarkUnsubscribed.mockResolvedValue(undefined);
});

function unsubscribe(token: string) {
  return fetch(`${baseUrl}/digest/unsubscribe/${token}`, { method: 'POST' });
}

describe('POST /digest/unsubscribe/:token', () => {
  it('unsubscribes the user the token names', async () => {
    const res = await unsubscribe(signUnsubscribeToken(42));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { unsubscribed: true } });
    expect(mockMarkUnsubscribed).toHaveBeenCalledWith(42, { __admin: true });
  });

  // Preferences may not exist yet for a user who never opened settings, and
  // markUnsubscribed updates a row rather than creating one.
  it('creates default preferences before marking the row', async () => {
    await unsubscribe(signUnsubscribeToken(42));

    expect(mockUpsertDefaults).toHaveBeenCalledWith(42, { __admin: true });
    expect(mockUpsertDefaults.mock.invocationCallOrder[0]).toBeLessThan(
      mockMarkUnsubscribed.mock.invocationCallOrder[0]!,
    );
  });

  // Clicking twice, or an email client prefetching the link, must not error.
  it('is idempotent across repeated calls', async () => {
    const token = signUnsubscribeToken(42);

    expect((await unsubscribe(token)).status).toBe(200);
    expect((await unsubscribe(token)).status).toBe(200);
    expect(mockMarkUnsubscribed).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['a tampered signature', '42.deadbeef'],
    ['a swapped user id', '99.deadbeef'],
    ['no signature at all', '42'],
    ['an empty token', '%20'],
    ['a non-numeric id', 'abc.deadbeef'],
  ])('rejects %s with 400 and writes nothing', async (_label, token) => {
    const res = await unsubscribe(token);

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('INVALID_TOKEN');
    expect(mockMarkUnsubscribed).not.toHaveBeenCalled();
    expect(mockUpsertDefaults).not.toHaveBeenCalled();
  });

  // The signature covers the id, so lifting one user's signature onto another's
  // id must not unsubscribe them.
  it('rejects one user’s signature replayed under another id', async () => {
    const [, sig] = signUnsubscribeToken(42).split('.');

    const res = await unsubscribe(`43.${sig}`);

    expect(res.status).toBe(400);
    expect(mockMarkUnsubscribed).not.toHaveBeenCalled();
  });
});
