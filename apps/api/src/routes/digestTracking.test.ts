import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import express from 'express';
import type { AddressInfo } from 'node:net';

const mockTrackEvent = vi.fn().mockResolvedValue(undefined);

vi.mock('../services/analytics/trackEvent.js', () => ({
  trackEvent: mockTrackEvent,
}));

vi.mock('../config.js', () => ({
  env: { JWT_SECRET: 'a'.repeat(64), NODE_ENV: 'test' },
}));

vi.mock('../lib/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

const { signDigestTrackingToken } = await import('../jobs/digest/trackingToken.js');
const { digestTrackingRouter } = await import('./digestTracking.js');

// The canonical 1x1 transparent GIF decodes to 42 bytes (56 base64 chars,
// 56/4*3 = 42). Pinning the constant against the live decode keeps the
// assertion truthful even if the source string is ever reformatted.
const PIXEL_BYTES = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  'base64',
).length;

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(digestTrackingRouter);
  server = await new Promise<http.Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const port = (server.address() as AddressInfo).port;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

beforeEach(() => vi.clearAllMocks());

const VALID_PAYLOAD = { userId: 7, orgId: 42, weekStart: '2026-05-04T00:00:00.000Z' };

describe('GET /track/digest/open', () => {
  it('returns the 42-byte transparent GIF with no-store headers on a valid token', async () => {
    const token = signDigestTrackingToken(VALID_PAYLOAD);
    const res = await fetch(`${baseUrl}/track/digest/open?t=${encodeURIComponent(token)}`);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/image\/gif/);
    expect(res.headers.get('cache-control')).toMatch(/no-store/);
    expect(res.headers.get('cache-control')).toMatch(/private/);
    expect(res.headers.get('pragma')).toMatch(/no-cache/);

    const body = Buffer.from(await res.arrayBuffer());
    expect(body.length).toBe(PIXEL_BYTES);
  });

  it('emits DIGEST_OPENED with token-recovered context on valid token', async () => {
    const token = signDigestTrackingToken(VALID_PAYLOAD);
    await fetch(`${baseUrl}/track/digest/open?t=${encodeURIComponent(token)}`, {
      headers: { 'user-agent': 'Mozilla/5.0 (test)' },
    });

    expect(mockTrackEvent).toHaveBeenCalledTimes(1);
    const [orgId, userId, eventName, metadata] = mockTrackEvent.mock.calls[0]!;
    expect(orgId).toBe(VALID_PAYLOAD.orgId);
    expect(userId).toBe(VALID_PAYLOAD.userId);
    expect(eventName).toBe('digest.opened');
    expect(metadata).toMatchObject({
      weekStart: VALID_PAYLOAD.weekStart,
      userAgent: 'Mozilla/5.0 (test)',
    });
    expect(typeof (metadata as Record<string, unknown>).openedAt).toBe('string');
  });

  it('returns the GIF without emitting on missing token', async () => {
    const res = await fetch(`${baseUrl}/track/digest/open`);
    expect(res.status).toBe(200);
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.length).toBe(PIXEL_BYTES);
    expect(mockTrackEvent).not.toHaveBeenCalled();
  });

  it('returns the GIF without emitting on tampered token', async () => {
    const token = signDigestTrackingToken(VALID_PAYLOAD);
    const tampered = token.slice(0, -4) + 'XXXX';
    const res = await fetch(`${baseUrl}/track/digest/open?t=${encodeURIComponent(tampered)}`);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/image\/gif/);
    expect(mockTrackEvent).not.toHaveBeenCalled();
  });

  it('returns the GIF without emitting when t is supplied as an array (?t=a&t=b)', async () => {
    // Express parses repeated query keys into string[]; the route's typeof
    // string check coerces that to an empty token rather than misinterpreting
    // either value as the real one.
    const res = await fetch(`${baseUrl}/track/digest/open?t=a&t=b`);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/image\/gif/);
    expect(mockTrackEvent).not.toHaveBeenCalled();
  });
});

describe('POST /track/digest/click', () => {
  it('emits DIGEST_CLICKED on valid token', async () => {
    const token = signDigestTrackingToken(VALID_PAYLOAD);
    const res = await fetch(`${baseUrl}/track/digest/click`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean };
    expect(json).toEqual({ ok: true });

    expect(mockTrackEvent).toHaveBeenCalledTimes(1);
    const [orgId, userId, eventName, metadata] = mockTrackEvent.mock.calls[0]!;
    expect(orgId).toBe(VALID_PAYLOAD.orgId);
    expect(userId).toBe(VALID_PAYLOAD.userId);
    expect(eventName).toBe('digest.clicked');
    expect(metadata).toMatchObject({
      weekStart: VALID_PAYLOAD.weekStart,
      utmCampaign: 'weekly-digest',
      destination: '/dashboard',
    });
  });

  it('returns 200 without emitting on invalid token', async () => {
    const res = await fetch(`${baseUrl}/track/digest/click`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'not-a-real-token' }),
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean };
    expect(json).toEqual({ ok: true });
    expect(mockTrackEvent).not.toHaveBeenCalled();
  });

  it('returns 200 { ok: true } without emitting on wrong body shape (no validity signal)', async () => {
    const res = await fetch(`${baseUrl}/track/digest/click`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wrong: 'shape' }),
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean };
    expect(json).toEqual({ ok: true });
    expect(mockTrackEvent).not.toHaveBeenCalled();
  });

  it('returns 200 { ok: true } without emitting on empty body', async () => {
    const res = await fetch(`${baseUrl}/track/digest/click`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean };
    expect(json).toEqual({ ok: true });
    expect(mockTrackEvent).not.toHaveBeenCalled();
  });
});
