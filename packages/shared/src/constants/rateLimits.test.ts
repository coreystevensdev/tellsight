import { describe, it, expect } from 'vitest';
import { RATE_LIMITS } from './index.js';

// NFR14 names three of these numbers: auth 10/min/IP, AI generation 5/min/user,
// public 60/min/IP. Nothing referenced RATE_LIMITS from a test, so the constants
// could drift away from the requirement and no build would notice.
//
// Only the three NFR14 names are pinned. dashboardCompute and
// statCorrectionTier1 are tuning decisions, not stated requirements, and pinning
// them here would turn ordinary tuning into a test failure.

describe('RATE_LIMITS matches NFR14', () => {
  it('allows 10 auth attempts per minute', () => {
    expect(RATE_LIMITS.auth).toEqual({ max: 10, windowMs: 60_000 });
  });

  it('allows 5 AI generations per minute', () => {
    expect(RATE_LIMITS.ai).toEqual({ max: 5, windowMs: 60_000 });
  });

  it('allows 60 public requests per minute', () => {
    expect(RATE_LIMITS.public).toEqual({ max: 60, windowMs: 60_000 });
  });

  // The windows are what make "per minute" true. A tier that kept max: 10 but
  // moved to a 10-minute window would satisfy the assertions above read
  // loosely, so check the unit itself.
  it.each(['auth', 'ai', 'public'] as const)('expresses %s as a per-minute window', (tier) => {
    expect(RATE_LIMITS[tier].windowMs).toBe(60_000);
  });
});
