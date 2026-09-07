import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import express from 'express';
import type { AddressInfo } from 'node:net';
import Stripe from 'stripe';

// stripeWebhook.test.ts mocks constructEvent, so its 400 comes from the mock
// throwing rather than from any signature being checked. Verifying against a
// deliberately wrong secret left every test there passing. This file runs the
// route against the real SDK so an actual HMAC is computed, which is also the
// only way to prove express.raw hands Stripe a body it can still verify: a
// parsed-and-restringified body has the same meaning and a different signature.

// Deliberately low entropy, matching the fixtures elsewhere in the repo:
// generateTestHeaderString takes any string as the HMAC key, and a realistic
// looking one trips the secret scanner.
const WEBHOOK_SECRET = 'whsec_test_signing_key';

const mockHandleWebhookEvent = vi.fn();

vi.mock('../services/subscription/index.js', () => ({
  getStripe: () => new Stripe('sk_test_x'),
  handleWebhookEvent: (...args: unknown[]) => mockHandleWebhookEvent(...args),
}));

vi.mock('../config.js', () => ({
  env: { STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET, NODE_ENV: 'test' },
}));

vi.mock('../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn().mockReturnValue({}) },
}));

const { stripeWebhookRouter } = await import('./stripeWebhook.js');

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(stripeWebhookRouter);

  server = await new Promise<http.Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

// Indented on purpose. A compact payload survives JSON.parse then
// JSON.stringify byte for byte, so a route that re-serialised the body before
// verifying would still pass. With whitespace in it, only the exact bytes
// received verify, which is the property express.raw exists to preserve.
const PAYLOAD = JSON.stringify(
  {
    id: 'evt_signature_test',
    type: 'customer.subscription.updated',
    data: { object: { id: 'sub_1' } },
  },
  null,
  2,
);

function post(body: string, signature: string) {
  return fetch(`${baseUrl}/webhooks/stripe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'stripe-signature': signature },
    body,
  });
}

function sign(payload: string, secret = WEBHOOK_SECRET) {
  return Stripe.webhooks.generateTestHeaderString({ payload, secret });
}

describe('Stripe webhook signature, verified for real', () => {
  it('accepts a payload signed with the configured secret', async () => {
    const res = await post(PAYLOAD, sign(PAYLOAD));

    expect(res.status).toBe(200);
    expect(mockHandleWebhookEvent).toHaveBeenCalled();
  });

  it('rejects a body edited after signing', async () => {
    const signature = sign(PAYLOAD);
    const tampered = PAYLOAD.replace('sub_1', 'sub_2');

    const res = await post(tampered, signature);

    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('INVALID_SIGNATURE');
  });

  // The failure a wrong STRIPE_WEBHOOK_SECRET in the environment produces.
  it('rejects a payload signed with a different secret', async () => {
    const other = 'whsec_a_different_key';

    const res = await post(PAYLOAD, sign(PAYLOAD, other));

    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('INVALID_SIGNATURE');
  });

  it('rejects a request with no signature header at all', async () => {
    const res = await fetch(`${baseUrl}/webhooks/stripe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: PAYLOAD,
    });

    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('MISSING_SIGNATURE');
  });
});
