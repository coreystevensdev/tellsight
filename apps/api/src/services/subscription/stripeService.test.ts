import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSessionsCreate = vi.fn();
const mockPortalSessionsCreate = vi.fn();
const mockGetSubscriptionByOrgId = vi.fn();

vi.mock('stripe', () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      checkout: { sessions: { create: mockSessionsCreate } },
      billingPortal: { sessions: { create: mockPortalSessionsCreate } },
      webhooks: { constructEvent: vi.fn() },
    })),
  };
});

vi.mock('../../db/queries/index.js', () => ({
  subscriptionsQueries: {
    getSubscriptionByOrgId: mockGetSubscriptionByOrgId,
  },
}));

vi.mock('../../lib/db.js', () => ({
  db: {},
  dbAdmin: {},
}));

vi.mock('../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../config.js', () => ({
  env: {
    STRIPE_SECRET_KEY: 'sk_test_fake',
    STRIPE_PRICE_ID: 'price_test_fake',
    APP_URL: 'http://localhost:3000',
  },
}));

const { createCheckoutSession, createPortalSession } = await import('./stripeService.js');

describe('stripeService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('createCheckoutSession', () => {
    it('creates a checkout session and returns the URL', async () => {
      mockGetSubscriptionByOrgId.mockResolvedValueOnce(null);
      mockSessionsCreate.mockResolvedValueOnce({
        id: 'cs_test_123',
        url: 'https://checkout.stripe.com/session/cs_test_123',
      });

      const result = await createCheckoutSession(10, 1);

      expect(result.checkoutUrl).toBe('https://checkout.stripe.com/session/cs_test_123');
      expect(mockSessionsCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          mode: 'subscription',
          line_items: [{ price: 'price_test_fake', quantity: 1 }],
          metadata: { orgId: '10', userId: '1' },
          success_url: 'http://localhost:3000/billing?session_id={CHECKOUT_SESSION_ID}',
          cancel_url: 'http://localhost:3000/billing?canceled=true',
        }),
      );
    });

    it('reuses existing stripe_customer_id when present', async () => {
      mockGetSubscriptionByOrgId.mockResolvedValueOnce({
        stripeCustomerId: 'cus_existing',
      });
      mockSessionsCreate.mockResolvedValueOnce({
        id: 'cs_test_456',
        url: 'https://checkout.stripe.com/session/cs_test_456',
      });

      await createCheckoutSession(10, 1);

      expect(mockSessionsCreate).toHaveBeenCalledWith(
        expect.objectContaining({ customer: 'cus_existing' }),
      );
    });

    it('wraps Stripe errors in ExternalServiceError', async () => {
      mockGetSubscriptionByOrgId.mockResolvedValueOnce(null);
      mockSessionsCreate.mockRejectedValueOnce(new Error('Stripe is down'));

      await expect(createCheckoutSession(10, 1)).rejects.toThrow('External service error: Stripe');
    });
  });

  describe('createPortalSession', () => {
    it('creates a portal session and returns the URL', async () => {
      mockPortalSessionsCreate.mockResolvedValueOnce({
        url: 'https://billing.stripe.com/session/bps_test_123',
      });

      const result = await createPortalSession('cus_test');

      expect(result.portalUrl).toBe('https://billing.stripe.com/session/bps_test_123');
      expect(mockPortalSessionsCreate).toHaveBeenCalledWith({
        customer: 'cus_test',
        return_url: 'http://localhost:3000/billing',
      });
    });

    it('wraps Stripe errors in ExternalServiceError', async () => {
      mockPortalSessionsCreate.mockRejectedValueOnce(new Error('Stripe is down'));

      await expect(createPortalSession('cus_test')).rejects.toThrow('External service error: Stripe');
    });
  });
});
