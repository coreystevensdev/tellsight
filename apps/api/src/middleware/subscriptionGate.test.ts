import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Response, NextFunction } from 'express';

import type { TieredRequest } from './subscriptionGate.js';

vi.mock('../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const mockGetActiveTier = vi.fn();
vi.mock('../db/queries/index.js', () => ({
  subscriptionsQueries: {
    getActiveTier: (...args: unknown[]) => mockGetActiveTier(...args),
  },
}));

const mockTrackEvent = vi.fn();
vi.mock('../services/analytics/trackEvent.js', () => ({
  trackEvent: (...args: unknown[]) => mockTrackEvent(...args),
}));

function makeReq(overrides = {}): TieredRequest {
  return { subscriptionTier: undefined, ...overrides } as unknown as TieredRequest;
}

describe('subscriptionGate', () => {
  let next: NextFunction;

  beforeEach(() => {
    vi.clearAllMocks();
    next = vi.fn();
  });

  it('sets subscriptionTier to free when no subscription exists', async () => {
    mockGetActiveTier.mockResolvedValue('free');
    const req = makeReq({ user: { org_id: 1, sub: '1' } });
    const res = {} as Response;

    const { subscriptionGate } = await import('./subscriptionGate.js');
    await subscriptionGate(req, res, next);

    expect(req.subscriptionTier).toBe('free');
    expect(next).toHaveBeenCalled();
  });

  it('sets subscriptionTier to pro when active subscription found', async () => {
    mockGetActiveTier.mockResolvedValue('pro');
    const req = makeReq({ user: { org_id: 1, sub: '1' } });
    const res = {} as Response;

    const { subscriptionGate } = await import('./subscriptionGate.js');
    await subscriptionGate(req, res, next);

    expect(req.subscriptionTier).toBe('pro');
    expect(next).toHaveBeenCalled();
  });

  it('defaults to free on query error', async () => {
    mockGetActiveTier.mockRejectedValue(new Error('DB down'));
    const req = makeReq({ user: { org_id: 1, sub: '1' } });
    const res = {} as Response;

    const { subscriptionGate } = await import('./subscriptionGate.js');
    await subscriptionGate(req, res, next);

    expect(req.subscriptionTier).toBe('free');
    expect(next).toHaveBeenCalled();
  });

  it('defaults to free when no user/orgId present', async () => {
    const req = makeReq();
    const res = {} as Response;

    const { subscriptionGate } = await import('./subscriptionGate.js');
    await subscriptionGate(req, res, next);

    expect(req.subscriptionTier).toBe('free');
    expect(mockGetActiveTier).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalled();
  });

  it('never sends a 403 — always calls next()', async () => {
    mockGetActiveTier.mockResolvedValue('free');
    const req = makeReq({ user: { org_id: 1, sub: '1' } });
    const res = { status: vi.fn(), json: vi.fn() } as unknown as Response;

    const { subscriptionGate } = await import('./subscriptionGate.js');
    await subscriptionGate(req, res, next);

    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith();
  });

  it('fires subscription.status_checked analytics event for authenticated requests', async () => {
    mockGetActiveTier.mockResolvedValue('pro');
    const req = makeReq({ user: { org_id: 5, sub: '42' } });
    const res = {} as Response;

    const { subscriptionGate } = await import('./subscriptionGate.js');
    await subscriptionGate(req, res, next);

    expect(mockTrackEvent).toHaveBeenCalledWith(
      5,
      42,
      'subscription.status_checked',
      { tier: 'pro', source: 'gate' },
    );
  });

  it('skips analytics event for unauthenticated requests', async () => {
    const req = makeReq();
    const res = {} as Response;

    const { subscriptionGate } = await import('./subscriptionGate.js');
    await subscriptionGate(req, res, next);

    expect(mockTrackEvent).not.toHaveBeenCalled();
  });
});
