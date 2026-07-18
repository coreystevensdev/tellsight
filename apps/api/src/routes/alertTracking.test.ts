import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import express from 'express';
import type { AddressInfo } from 'node:net';

const mockTrackEvent = vi.fn();

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

const { signAlertTrackingToken } = await import('../jobs/alerts/trackingToken.js');
const { alertTrackingRouter } = await import('./alertTracking.js');

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(alertTrackingRouter);
  server = await new Promise<http.Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const port = (server.address() as AddressInfo).port;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

beforeEach(() => vi.clearAllMocks());

const VALID_PAYLOAD = {
  orgId: 42,
  userId: 7,
  ruleId: 3,
  ruleKind: 'runway_runs_short' as const,
  fireId: 999,
};

describe('POST /track/alert/click', () => {
  it('emits ALERT_CLICKED on valid token', async () => {
    const token = signAlertTrackingToken(VALID_PAYLOAD);
    const res = await fetch(`${baseUrl}/track/alert/click`, {
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
    expect(eventName).toBe('alert.clicked');
    expect(metadata).toMatchObject({
      ruleId: VALID_PAYLOAD.ruleId,
      ruleKind: VALID_PAYLOAD.ruleKind,
      fireId: VALID_PAYLOAD.fireId,
      destination: '/dashboard',
    });
  });

  it('returns 200 without emitting on invalid token', async () => {
    const res = await fetch(`${baseUrl}/track/alert/click`, {
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
    const res = await fetch(`${baseUrl}/track/alert/click`, {
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
    const res = await fetch(`${baseUrl}/track/alert/click`, {
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
