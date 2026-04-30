import { describe, it, expect, vi, beforeEach } from 'vitest';
import type Stripe from 'stripe';

const mockUpsertSubscription = vi.fn();
const mockUpdateSubscriptionPeriod = vi.fn();
const mockUpdateSubscriptionStatus = vi.fn();
const mockGetSubscriptionByStripeId = vi.fn();
const mockGetOrgOwnerId = vi.fn();
const mockTrackEvent = vi.fn();
const mockAuditRecord = vi.fn().mockResolvedValue(undefined);

vi.mock('../../db/queries/index.js', () => ({
  subscriptionsQueries: {
    upsertSubscription: mockUpsertSubscription,
    updateSubscriptionPeriod: mockUpdateSubscriptionPeriod,
    updateSubscriptionStatus: mockUpdateSubscriptionStatus,
    getSubscriptionByStripeId: mockGetSubscriptionByStripeId,
  },
  userOrgsQueries: {
    getOrgOwnerId: mockGetOrgOwnerId,
  },
  auditLogsQueries: {
    record: mockAuditRecord,
  },
}));

vi.mock('../analytics/trackEvent.js', () => ({
  trackEvent: mockTrackEvent,
}));

vi.mock('../../lib/db.js', () => ({
  dbAdmin: {},
}));

vi.mock('../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { handleWebhookEvent } = await import('./webhookHandler.js');

function fakeCheckoutEvent(overrides = {}): Stripe.Event {
  return {
    id: 'evt_test_123',
    type: 'checkout.session.completed',
    data: {
      object: {
        id: 'cs_test_123',
        customer: 'cus_test_456',
        subscription: 'sub_test_789',
        metadata: { orgId: '10', userId: '1' },
        ...overrides,
      },
    },
  } as unknown as Stripe.Event;
}

function fakeSubscriptionUpdatedEvent(overrides = {}): Stripe.Event {
  return {
    id: 'evt_sub_update_123',
    type: 'customer.subscription.updated',
    data: {
      object: {
        id: 'sub_test_789',
        customer: 'cus_test_456',
        status: 'active',
        cancel_at_period_end: false,
        current_period_end: 1735689600, // 2025-01-01T00:00:00Z
        metadata: { orgId: '10' },
        ...overrides,
      },
    },
  } as unknown as Stripe.Event;
}

function fakeInvoicePaymentFailedEvent(overrides = {}): Stripe.Event {
  return {
    id: 'evt_inv_fail_123',
    type: 'invoice.payment_failed',
    data: {
      object: {
        id: 'in_test_123',
        subscription: 'sub_test_789',
        ...overrides,
      },
    },
  } as unknown as Stripe.Event;
}

function fakeSubscriptionDeletedEvent(overrides = {}): Stripe.Event {
  return {
    id: 'evt_sub_del_123',
    type: 'customer.subscription.deleted',
    data: {
      object: {
        id: 'sub_test_789',
        customer: 'cus_test_456',
        status: 'canceled',
        current_period_end: 1735689600,
        metadata: { orgId: '10' },
        ...overrides,
      },
    },
  } as unknown as Stripe.Event;
}

describe('webhookHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('checkout.session.completed', () => {
    it('upserts subscription and fires analytics event', async () => {
      mockUpsertSubscription.mockResolvedValueOnce({ id: 1 });

      await handleWebhookEvent(fakeCheckoutEvent());

      expect(mockUpsertSubscription).toHaveBeenCalledWith({
        orgId: 10,
        stripeCustomerId: 'cus_test_456',
        stripeSubscriptionId: 'sub_test_789',
        status: 'active',
        plan: 'pro',
        currentPeriodEnd: null,
      }, expect.anything());

      expect(mockTrackEvent).toHaveBeenCalledWith(
        10,
        1,
        'subscription.upgraded',
        { stripeSessionId: 'cs_test_123' },
      );
    });

    it('is idempotent, calling twice does not error', async () => {
      mockUpsertSubscription.mockResolvedValue({ id: 1 });

      await handleWebhookEvent(fakeCheckoutEvent());
      await handleWebhookEvent(fakeCheckoutEvent());

      expect(mockUpsertSubscription).toHaveBeenCalledTimes(2);
    });

    it('skips processing when metadata is missing orgId', async () => {
      await handleWebhookEvent(fakeCheckoutEvent({ metadata: {} }));

      expect(mockUpsertSubscription).not.toHaveBeenCalled();
      expect(mockTrackEvent).not.toHaveBeenCalled();
    });
  });

  describe('customer.subscription.updated', () => {
    it('updates period dates on renewal', async () => {
      await handleWebhookEvent(fakeSubscriptionUpdatedEvent());

      expect(mockUpdateSubscriptionPeriod).toHaveBeenCalledWith(
        'sub_test_789',
        new Date(1735689600 * 1000),
        expect.anything(),
      );
    });

    it('marks subscription as canceled when cancel_at_period_end is true', async () => {
      mockGetOrgOwnerId.mockResolvedValueOnce(1);

      await handleWebhookEvent(fakeSubscriptionUpdatedEvent({
        cancel_at_period_end: true,
      }));

      expect(mockUpdateSubscriptionStatus).toHaveBeenCalledWith(
        'sub_test_789',
        'canceled',
        new Date(1735689600 * 1000),
        expect.anything(),
      );
    });

    it('fires subscription.cancelled analytics event on cancellation', async () => {
      mockGetOrgOwnerId.mockResolvedValueOnce(1);

      await handleWebhookEvent(fakeSubscriptionUpdatedEvent({
        cancel_at_period_end: true,
      }));

      expect(mockGetOrgOwnerId).toHaveBeenCalledWith(10, expect.anything());
      expect(mockTrackEvent).toHaveBeenCalledWith(
        10,
        1,
        'subscription.cancelled',
        { stripeSubscriptionId: 'sub_test_789' },
      );
    });

    it('reverts status to active on reactivation (cancel_at_period_end false)', async () => {
      await handleWebhookEvent(fakeSubscriptionUpdatedEvent({
        cancel_at_period_end: false,
        status: 'active',
      }));

      expect(mockUpdateSubscriptionStatus).toHaveBeenCalledWith(
        'sub_test_789',
        'active',
        new Date(1735689600 * 1000),
        expect.anything(),
      );
    });

    it('updates status to past_due on payment failure', async () => {
      await handleWebhookEvent(fakeSubscriptionUpdatedEvent({
        status: 'past_due',
      }));

      expect(mockUpdateSubscriptionPeriod).toHaveBeenCalledWith(
        'sub_test_789',
        new Date(1735689600 * 1000),
        expect.anything(),
      );
      expect(mockUpdateSubscriptionStatus).toHaveBeenCalledWith(
        'sub_test_789',
        'past_due',
        new Date(1735689600 * 1000),
        expect.anything(),
      );
    });

    it('is idempotent, duplicate cancellation webhook is a no-op', async () => {
      mockGetOrgOwnerId.mockResolvedValue(1);

      const event = fakeSubscriptionUpdatedEvent({ cancel_at_period_end: true });
      await handleWebhookEvent(event);
      await handleWebhookEvent(event);

      // updateSubscriptionStatus is idempotent at DB level (WHERE status != target)
      // but the handler calls it both times, DB-layer idempotency handles it
      expect(mockUpdateSubscriptionStatus).toHaveBeenCalledTimes(2);
    });

    it('handles missing orgId metadata gracefully', async () => {
      await handleWebhookEvent(fakeSubscriptionUpdatedEvent({
        metadata: {},
      }));

      expect(mockUpdateSubscriptionPeriod).not.toHaveBeenCalled();
      expect(mockUpdateSubscriptionStatus).not.toHaveBeenCalled();
      expect(mockTrackEvent).not.toHaveBeenCalled();
    });

    it('skips analytics event when org owner lookup fails', async () => {
      mockGetOrgOwnerId.mockResolvedValueOnce(null);

      await handleWebhookEvent(fakeSubscriptionUpdatedEvent({
        cancel_at_period_end: true,
      }));

      expect(mockUpdateSubscriptionStatus).toHaveBeenCalled();
      expect(mockTrackEvent).not.toHaveBeenCalled();
    });
  });

  describe('invoice.payment_failed', () => {
    it('updates subscription to past_due status', async () => {
      mockGetSubscriptionByStripeId.mockResolvedValueOnce({ orgId: 10, stripeSubscriptionId: 'sub_test_789' });
      mockGetOrgOwnerId.mockResolvedValueOnce(1);

      await handleWebhookEvent(fakeInvoicePaymentFailedEvent());

      expect(mockGetSubscriptionByStripeId).toHaveBeenCalledWith('sub_test_789', expect.anything());
      expect(mockUpdateSubscriptionStatus).toHaveBeenCalledWith('sub_test_789', 'past_due', undefined, expect.anything());
    });

    it('fires subscription.payment_failed analytics event', async () => {
      mockGetSubscriptionByStripeId.mockResolvedValueOnce({ orgId: 10, stripeSubscriptionId: 'sub_test_789' });
      mockGetOrgOwnerId.mockResolvedValueOnce(1);

      await handleWebhookEvent(fakeInvoicePaymentFailedEvent());

      expect(mockTrackEvent).toHaveBeenCalledWith(
        10,
        1,
        'subscription.payment_failed',
        { stripeSubscriptionId: 'sub_test_789' },
      );
    });

    it('is idempotent, duplicate webhook is a no-op at DB level', async () => {
      mockGetSubscriptionByStripeId.mockResolvedValue({ orgId: 10, stripeSubscriptionId: 'sub_test_789' });
      mockGetOrgOwnerId.mockResolvedValue(1);

      await handleWebhookEvent(fakeInvoicePaymentFailedEvent());
      await handleWebhookEvent(fakeInvoicePaymentFailedEvent());

      // handler calls updateSubscriptionStatus both times, DB WHERE clause deduplicates
      expect(mockUpdateSubscriptionStatus).toHaveBeenCalledTimes(2);
    });

    it('handles missing subscription gracefully', async () => {
      mockGetSubscriptionByStripeId.mockResolvedValueOnce(null);

      await handleWebhookEvent(fakeInvoicePaymentFailedEvent());

      expect(mockUpdateSubscriptionStatus).not.toHaveBeenCalled();
      expect(mockTrackEvent).not.toHaveBeenCalled();
    });

    it('skips analytics when org owner not found', async () => {
      mockGetSubscriptionByStripeId.mockResolvedValueOnce({ orgId: 10, stripeSubscriptionId: 'sub_test_789' });
      mockGetOrgOwnerId.mockResolvedValueOnce(null);

      await handleWebhookEvent(fakeInvoicePaymentFailedEvent());

      expect(mockUpdateSubscriptionStatus).toHaveBeenCalledWith('sub_test_789', 'past_due', undefined, expect.anything());
      expect(mockTrackEvent).not.toHaveBeenCalled();
    });

    it('skips when invoice has no subscription', async () => {
      await handleWebhookEvent(fakeInvoicePaymentFailedEvent({ subscription: null }));

      expect(mockGetSubscriptionByStripeId).not.toHaveBeenCalled();
      expect(mockUpdateSubscriptionStatus).not.toHaveBeenCalled();
    });

    it('handles expanded subscription object', async () => {
      mockGetSubscriptionByStripeId.mockResolvedValueOnce({ orgId: 10, stripeSubscriptionId: 'sub_test_789' });
      mockGetOrgOwnerId.mockResolvedValueOnce(1);

      await handleWebhookEvent(fakeInvoicePaymentFailedEvent({
        subscription: { id: 'sub_test_789' },
      }));

      expect(mockGetSubscriptionByStripeId).toHaveBeenCalledWith('sub_test_789', expect.anything());
      expect(mockUpdateSubscriptionStatus).toHaveBeenCalledWith('sub_test_789', 'past_due', undefined, expect.anything());
    });
  });

  describe('customer.subscription.deleted', () => {
    it('updates subscription to expired status', async () => {
      mockGetOrgOwnerId.mockResolvedValueOnce(1);

      await handleWebhookEvent(fakeSubscriptionDeletedEvent());

      expect(mockUpdateSubscriptionStatus).toHaveBeenCalledWith('sub_test_789', 'expired', undefined, expect.anything());
    });

    it('fires subscription.expired analytics event', async () => {
      mockGetOrgOwnerId.mockResolvedValueOnce(1);

      await handleWebhookEvent(fakeSubscriptionDeletedEvent());

      expect(mockGetOrgOwnerId).toHaveBeenCalledWith(10, expect.anything());
      expect(mockTrackEvent).toHaveBeenCalledWith(
        10,
        1,
        'subscription.expired',
        { stripeSubscriptionId: 'sub_test_789' },
      );
    });

    it('handles missing orgId metadata gracefully', async () => {
      await handleWebhookEvent(fakeSubscriptionDeletedEvent({ metadata: {} }));

      expect(mockUpdateSubscriptionStatus).not.toHaveBeenCalled();
      expect(mockTrackEvent).not.toHaveBeenCalled();
    });
  });

  describe('unhandled event types', () => {
    it('logs and returns without error', async () => {
      const event = { id: 'evt_test', type: 'payment_intent.succeeded', data: { object: {} } } as unknown as Stripe.Event;

      await expect(handleWebhookEvent(event)).resolves.toBeUndefined();
      expect(mockUpsertSubscription).not.toHaveBeenCalled();
    });
  });
});
