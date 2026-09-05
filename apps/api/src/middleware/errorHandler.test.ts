import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';

const mockCaptureException = vi.fn();

vi.mock('../lib/sentry.js', () => ({
  Sentry: { captureException: mockCaptureException },
}));

vi.mock('../config.js', () => ({
  env: { JWT_SECRET: 'a'.repeat(64), NODE_ENV: 'test' },
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
const { ValidationError, ProgrammerError } = await import('../lib/appError.js');

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  const result = await createTestApp((app) => {
    app.post('/echo', (req, res) => res.json({ data: req.body }));
    app.get('/app-error', () => {
      throw new ValidationError('name is required');
    });
    app.get('/programmer-error', () => {
      throw new ProgrammerError('invariant broken');
    });
    app.get('/boom', () => {
      throw new Error('something exploded');
    });
  });
  server = result.server;
  baseUrl = result.baseUrl;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

beforeEach(() => vi.clearAllMocks());

function postRaw(body: string) {
  return fetch(`${baseUrl}/echo`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
}

describe('errorHandler, application errors', () => {
  it('uses the AppError status and code', async () => {
    const res = await fetch(`${baseUrl}/app-error`);

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: { code: 'VALIDATION_ERROR', message: 'name is required' },
    });
  });

  it('reports a programmer error to Sentry', async () => {
    await fetch(`${baseUrl}/programmer-error`);

    expect(mockCaptureException).toHaveBeenCalledTimes(1);
  });

  it('returns a generic 500 for an unhandled error and reports it', async () => {
    const res = await fetch(`${baseUrl}/boom`);
    // Read once. An earlier version called res.json() and then res.text(), which
    // throws on an already-consumed body, so the not-toContain below was
    // asserting against an empty string and passed even when the raw message
    // was being returned to the client.
    const body = await res.text();

    expect(res.status).toBe(500);
    // toEqual, not toMatchObject: the message is the thing under test, and a
    // partial match would let the internal one through.
    expect(JSON.parse(body)).toEqual({
      error: { code: 'INTERNAL_SERVER_ERROR', message: 'An unexpected error occurred' },
    });
    expect(body).not.toContain('exploded');
    expect(mockCaptureException).toHaveBeenCalledTimes(1);
  });
});

// body-parser rejects these before any route runs, so they never become
// AppErrors and were falling through to the 500 branch: a caller posting a
// scalar got told the server had a problem, and every one of them woke Sentry.
describe('errorHandler, malformed request bodies', () => {
  it.each([
    ['truncated JSON', '{"a":'],
    ['a bare scalar, which strict mode rejects', '"nope"'],
    ['a bare number', '42'],
    ['not JSON at all', 'this is not json'],
  ])('answers 400 for %s', async (_label, body) => {
    const res = await postRaw(body);

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: 'INVALID_JSON' } });
  });

  it('answers 413 when the body is over the parser limit', async () => {
    const res = await postRaw(JSON.stringify({ blob: 'x'.repeat(200_000) }));

    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ error: { code: 'PAYLOAD_TOO_LARGE' } });
  });

  // The second half of the fix. A malformed body is the caller's mistake, and
  // paging on it buries the errors that are actually ours.
  it('does not report a malformed body to Sentry', async () => {
    await postRaw('{"a":');
    await postRaw(JSON.stringify({ blob: 'x'.repeat(200_000) }));

    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  it('still accepts a well-formed body', async () => {
    const res = await postRaw(JSON.stringify({ a: 1 }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { a: 1 } });
  });
});
