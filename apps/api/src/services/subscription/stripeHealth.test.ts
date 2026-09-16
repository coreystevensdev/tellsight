import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  retrieve: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
}));

vi.mock('./stripeService.js', () => ({
  getStripe: () => ({ balance: { retrieve: h.retrieve } }),
}));
vi.mock('../../lib/logger.js', () => ({
  logger: { error: h.error, warn: h.warn, info: h.info },
}));

const { checkStripeHealth, logStripeKeyStatus } = await import('./stripeHealth.js');

beforeEach(() => vi.clearAllMocks());

describe('checkStripeHealth', () => {
  it('reports ok and which mode the key belongs to', async () => {
    h.retrieve.mockResolvedValue({ livemode: true });

    const result = await checkStripeHealth();

    expect(result.status).toBe('ok');
    expect(result.livemode).toBe(true);
  });

  // The whole reason this exists. config.ts enforces the sk_live_ prefix, not
  // that the key works, so production ran for weeks on a live-shaped key Stripe
  // answers 401 to, which is the broken payment flow the prefix rule was
  // written to prevent.
  it.each([
    ['a typed authentication error', { type: 'StripeAuthenticationError' }],
    ['a bare 401', { statusCode: 401 }],
  ])('reports error on %s', async (_label, err) => {
    h.retrieve.mockRejectedValue(Object.assign(new Error('nope'), err));

    const result = await checkStripeHealth();

    expect(result.status).toBe('error');
    expect(result.detail).toMatch(/rejected/i);
  });

  // A timeout is Stripe having a bad minute. Calling that an error would have
  // the health endpoint report billing as broken every time their API hiccups,
  // and a check that cries wolf gets ignored exactly when it is right.
  it.each([
    ['a timeout', { type: 'StripeConnectionError' }],
    ['a 500', { statusCode: 500 }],
    ['an unrecognised failure', {}],
  ])('reports unknown, not error, on %s', async (_label, err) => {
    h.retrieve.mockRejectedValue(Object.assign(new Error('transient'), err));

    const result = await checkStripeHealth();

    expect(result.status).toBe('unknown');
  });
});

describe('logStripeKeyStatus', () => {
  it('logs at error level when the key is rejected', async () => {
    h.retrieve.mockRejectedValue(Object.assign(new Error('nope'), { statusCode: 401 }));

    await logStripeKeyStatus();

    expect(h.error).toHaveBeenCalledWith(expect.anything(), expect.stringMatching(/rejected/i));
    expect(h.warn).not.toHaveBeenCalled();
  });

  it('warns rather than errors when Stripe is simply unreachable', async () => {
    h.retrieve.mockRejectedValue(new Error('socket hang up'));

    await logStripeKeyStatus();

    expect(h.warn).toHaveBeenCalled();
    expect(h.error).not.toHaveBeenCalled();
  });

  // Billing being misconfigured must not stop the dashboard, the digests or the
  // connectors from serving, so boot calls this without awaiting a result it
  // could act on.
  it('never throws, whatever Stripe does', async () => {
    h.retrieve.mockRejectedValue(new Error('boom'));
    await expect(logStripeKeyStatus()).resolves.toBeUndefined();
  });
});
