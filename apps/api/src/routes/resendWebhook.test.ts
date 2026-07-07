import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { Webhook } from 'svix';

// 32 random bytes, base64: svix accepts whsec_<base64> as the shared secret.
const TEST_SECRET = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw';

const mockTrackEvent = vi.fn();
const mockTrackEventSystem = vi.fn();

vi.mock('../services/analytics/trackEvent.js', () => ({
  trackEvent: mockTrackEvent,
  trackEventSystem: mockTrackEventSystem,
}));

vi.mock('../config.js', () => ({
  env: {
    NODE_ENV: 'test',
    RESEND_WEBHOOK_SECRET: TEST_SECRET,
    EMAIL_FROM_ADDRESS: 'digest@tellsight.test',
  },
}));

vi.mock('../lib/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnValue({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

const { resendWebhookRouter } = await import('./resendWebhook.js');

let server: http.Server;
let baseUrl: string;

// Webhook router needs the raw body, so mount it BEFORE express.json().
// Production mounts the same way in apps/api/src/index.ts. Skip the standard
// createTestApp helper because that one applies json() up front.
beforeAll(async () => {
  const app = express();
  app.use(resendWebhookRouter);
  app.use(express.json());

  server = await new Promise<http.Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const port = (server.address() as AddressInfo).port;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

beforeEach(() => vi.clearAllMocks());

// Sign a payload the way Resend does, so the route's verify() exercises the
// real svix code path. Mocking the SDK would defeat the test's purpose.
function signedRequest(payload: object, options: { svixId?: string; tamperSig?: boolean } = {}) {
  const wh = new Webhook(TEST_SECRET);
  const body = JSON.stringify(payload);
  const svixId = options.svixId ?? `msg_${Math.random().toString(36).slice(2, 10)}`;
  const timestamp = new Date();
  const signature = wh.sign(svixId, timestamp, body);

  return {
    body,
    headers: {
      'svix-id': svixId,
      'svix-timestamp': String(Math.floor(timestamp.getTime() / 1000)),
      'svix-signature': options.tamperSig ? signature.replace(/.$/, 'X') : signature,
      'Content-Type': 'application/json',
    },
  };
}

describe('POST /webhooks/resend', () => {
  it('returns 400 when the signature has been tampered with', async () => {
    const { body, headers } = signedRequest(
      { type: 'email.bounced', data: { email_id: 'm', to: 'a@b.com' } },
      { tamperSig: true },
    );

    const res = await fetch(`${baseUrl}/webhooks/resend`, { method: 'POST', headers, body });
    const json = (await res.json()) as { error: { code: string } };

    expect(res.status).toBe(400);
    expect(json.error.code).toBe('INVALID_SIGNATURE');
    expect(mockTrackEvent).not.toHaveBeenCalled();
    expect(mockTrackEventSystem).not.toHaveBeenCalled();
  });

  it('returns 400 when svix headers are missing entirely', async () => {
    const res = await fetch(`${baseUrl}/webhooks/resend`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'email.bounced' }),
    });
    expect(res.status).toBe(400);
  });

  it('emits EMAIL_BOUNCED via trackEvent when tags carry org_id + user_id', async () => {
    const payload = {
      type: 'email.bounced',
      created_at: '2026-05-07T08:00:00Z',
      data: {
        email_id: 'msg-abc',
        to: 'corey@example.com',
        tags: [
          { name: 'template', value: 'digest-weekly-v1' },
          { name: 'org_id', value: '10' },
          { name: 'user_id', value: '7' },
        ],
        bounce: { type: 'Permanent', subType: 'General' },
      },
    };
    const { body, headers } = signedRequest(payload);

    const res = await fetch(`${baseUrl}/webhooks/resend`, { method: 'POST', headers, body });

    expect(res.status).toBe(200);
    expect(mockTrackEvent).toHaveBeenCalledWith(
      10,
      7,
      'email.bounced',
      expect.objectContaining({
        messageId: 'msg-abc',
        recipientEmail: 'co***@example.com',
        template: 'digest-weekly-v1',
        bounceType: 'Permanent',
      }),
    );
    expect(mockTrackEventSystem).not.toHaveBeenCalled();
  });

  it('emits EMAIL_COMPLAINED via trackEvent when tags resolve', async () => {
    const payload = {
      type: 'email.complained',
      created_at: '2026-05-07T08:01:00Z',
      data: {
        email_id: 'msg-xyz',
        to: ['alice@example.com'],
        tags: [
          { name: 'template', value: 'digest-weekly-v1' },
          { name: 'org_id', value: '10' },
          { name: 'user_id', value: '7' },
        ],
        complaint: { complaintFeedbackType: 'abuse' },
      },
    };
    const { body, headers } = signedRequest(payload);

    const res = await fetch(`${baseUrl}/webhooks/resend`, { method: 'POST', headers, body });

    expect(res.status).toBe(200);
    expect(mockTrackEvent).toHaveBeenCalledWith(
      10,
      7,
      'email.complained',
      expect.objectContaining({
        messageId: 'msg-xyz',
        recipientEmail: 'al***@example.com',
        complaintType: 'abuse',
      }),
    );
  });

  it('falls back to trackEventSystem when org_id/user_id tags are missing', async () => {
    const payload = {
      type: 'email.bounced',
      data: {
        email_id: 'msg-no-tags',
        to: 'orphan@example.com',
        tags: [{ name: 'template', value: 'digest-weekly-v1' }],
      },
    };
    const { body, headers } = signedRequest(payload);

    const res = await fetch(`${baseUrl}/webhooks/resend`, { method: 'POST', headers, body });

    expect(res.status).toBe(200);
    expect(mockTrackEventSystem).toHaveBeenCalledWith(
      'email.bounced',
      expect.objectContaining({
        messageId: 'msg-no-tags',
        recipientEmail: 'or***@example.com',
        template: 'digest-weekly-v1',
      }),
    );
    expect(mockTrackEvent).not.toHaveBeenCalled();
  });

  it('falls back to trackEventSystem when org_id is non-numeric', async () => {
    const payload = {
      type: 'email.bounced',
      data: {
        email_id: 'msg-bad-tag',
        to: 'a@b.com',
        tags: [
          { name: 'org_id', value: 'not-a-number' },
          { name: 'user_id', value: '7' },
        ],
      },
    };
    const { body, headers } = signedRequest(payload);

    const res = await fetch(`${baseUrl}/webhooks/resend`, { method: 'POST', headers, body });

    expect(res.status).toBe(200);
    expect(mockTrackEventSystem).toHaveBeenCalledTimes(1);
    expect(mockTrackEvent).not.toHaveBeenCalled();
  });

  it('acks unknown event types without emitting analytics', async () => {
    const payload = {
      type: 'email.delivered',
      data: { email_id: 'msg-d', to: 'a@b.com' },
    };
    const { body, headers } = signedRequest(payload);

    const res = await fetch(`${baseUrl}/webhooks/resend`, { method: 'POST', headers, body });

    expect(res.status).toBe(200);
    expect(mockTrackEvent).not.toHaveBeenCalled();
    expect(mockTrackEventSystem).not.toHaveBeenCalled();
  });

  it('idempotently acks repeated deliveries with the same svix-id', async () => {
    const payload = {
      type: 'email.bounced',
      data: {
        email_id: 'msg-idemp',
        to: 'a@b.com',
        tags: [
          { name: 'org_id', value: '10' },
          { name: 'user_id', value: '7' },
        ],
      },
    };
    const first = signedRequest(payload, { svixId: 'msg_replay_test' });
    const second = signedRequest(payload, { svixId: 'msg_replay_test' });

    const r1 = await fetch(`${baseUrl}/webhooks/resend`, { method: 'POST', headers: first.headers, body: first.body });
    const r2 = await fetch(`${baseUrl}/webhooks/resend`, { method: 'POST', headers: second.headers, body: second.body });

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(mockTrackEvent).toHaveBeenCalledTimes(2);
  });
});
