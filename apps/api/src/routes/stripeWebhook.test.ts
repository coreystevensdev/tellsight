import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';

const mockConstructEvent = vi.fn();
const mockHandleWebhookEvent = vi.fn();

vi.mock('../services/subscription/index.js', () => ({
  getStripe: () => ({ webhooks: { constructEvent: mockConstructEvent } }),
  handleWebhookEvent: mockHandleWebhookEvent,
}));

vi.mock('../config.js', () => ({
  env: {
    STRIPE_WEBHOOK_SECRET: 'whsec_test',
    NODE_ENV: 'test',
  },
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

const { createTestApp } = await import('../test/helpers/testApp.js');
const { stripeWebhookRouter } = await import('./stripeWebhook.js');

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  // beforeParsers, not setup. The comment here used to claim this was "a bare
  // Express app without JSON parser", which createTestApp was not: it mounted
  // express.json() first, so the router's express.raw() was a no-op and the
  // handler saw a parsed object. Mounting above the parser is what index.ts
  // does and is the only way the raw body survives.
  const result = await createTestApp(
    () => {},
    { beforeParsers: (app) => app.use(stripeWebhookRouter) },
  );
  server = result.server;
  baseUrl = result.baseUrl;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

beforeEach(() => vi.clearAllMocks());

describe('POST /webhooks/stripe', () => {
  it('returns 400 when stripe-signature header is missing', async () => {
    const res = await fetch(`${baseUrl}/webhooks/stripe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });

    expect(res.status).toBe(400);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = (await res.json()) as any;
    expect(json.error.code).toBe('MISSING_SIGNATURE');
  });

  // Stripe's constructEvent recomputes the HMAC over the exact bytes sent. Hand
  // it a parsed object and every real signature fails, so what it receives is
  // the whole point of mounting this router above express.json().
  it('hands stripe the unparsed body, not a parsed object', async () => {
    mockConstructEvent.mockReturnValueOnce({
      id: 'evt_raw',
      type: 'checkout.session.completed',
      data: { object: {} },
    });
    mockHandleWebhookEvent.mockResolvedValueOnce(undefined);
    const body = '{"id":"evt_raw","spacing":  "preserved"}';

    await fetch(`${baseUrl}/webhooks/stripe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'stripe-signature': 'sig' },
      body,
    });

    const [payload] = mockConstructEvent.mock.calls[0]!;
    expect(Buffer.isBuffer(payload)).toBe(true);
    // Byte for byte, including the double space json parsing would discard.
    expect((payload as Buffer).toString('utf8')).toBe(body);
  });

  it('returns 400 when signature is invalid', async () => {
    mockConstructEvent.mockImplementationOnce(() => {
      throw new Error('Invalid signature');
    });

    const res = await fetch(`${baseUrl}/webhooks/stripe`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'stripe-signature': 'invalid_sig',
      },
      body: '{}',
    });

    expect(res.status).toBe(400);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = (await res.json()) as any;
    expect(json.error.code).toBe('INVALID_SIGNATURE');
  });

  it('returns 200 and processes event when signature is valid', async () => {
    const fakeEvent = { id: 'evt_test', type: 'checkout.session.completed', data: { object: {} } };
    mockConstructEvent.mockReturnValueOnce(fakeEvent);
    mockHandleWebhookEvent.mockResolvedValueOnce(undefined);

    const res = await fetch(`${baseUrl}/webhooks/stripe`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'stripe-signature': 'valid_sig',
      },
      body: JSON.stringify(fakeEvent),
    });

    expect(res.status).toBe(200);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = (await res.json()) as any;
    expect(json.received).toBe(true);
    expect(mockHandleWebhookEvent).toHaveBeenCalledWith(fakeEvent);
  });
});
