import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  retrieve: vi.fn(),
  retrievePrice: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
}));

vi.mock('../../config.js', () => ({ env: { STRIPE_PRICE_ID: 'price_test_fake' } }));
vi.mock('./stripeService.js', () => ({
  getStripe: () => ({
    balance: { retrieve: h.retrieve },
    prices: { retrieve: h.retrievePrice },
  }),
}));
vi.mock('../../lib/logger.js', () => ({
  logger: { error: h.error, warn: h.warn, info: h.info },
}));

const { checkStripeHealth, logStripeKeyStatus } = await import('./stripeHealth.js');

beforeEach(() => {
  vi.clearAllMocks();
  h.retrieve.mockResolvedValue({ livemode: false });
  h.retrievePrice.mockResolvedValue({ id: 'price_test_fake', livemode: false });
});

describe('checkStripeHealth', () => {
  it('reports ok and which mode the key belongs to', async () => {
    h.retrieve.mockResolvedValue({ livemode: true });

    const result = await checkStripeHealth();

    expect(result.status).toBe('ok');
    expect(result.livemode).toBe(true);
  });

  // The whole reason this exists: config.ts enforces the sk_live_ prefix, not
  // that the key behind it works, and a correctly shaped key Stripe rejects is
  // the same broken payment flow the prefix rule was written to prevent.
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

  it('checks the configured price, not just the key', async () => {
    await checkStripeHealth();

    expect(h.retrievePrice).toHaveBeenCalledWith('price_test_fake', {}, expect.anything());
  });

  // The failure a half-finished mode switch produces: the key moves to the other
  // Stripe mode and the price id stays behind, so checkout dies on "No such price"
  // at the moment someone tries to upgrade.
  it('reports error when the price belongs to the other Stripe mode', async () => {
    h.retrievePrice.mockRejectedValue(
      Object.assign(new Error('No such price'), { statusCode: 404, type: 'StripeInvalidRequestError' }),
    );

    const result = await checkStripeHealth();

    expect(result.status).toBe('error');
    expect(result.detail).toMatch(/STRIPE_PRICE_ID/);
  });

  it('does not look up the price when the key is already rejected', async () => {
    h.retrieve.mockRejectedValue(Object.assign(new Error('nope'), { statusCode: 401 }));

    const result = await checkStripeHealth();

    expect(result.detail).toMatch(/rejected/i);
    expect(h.retrievePrice).not.toHaveBeenCalled();
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
