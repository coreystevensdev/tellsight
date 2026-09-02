import { createHmac } from 'node:crypto';

import { describe, it, expect, vi } from 'vitest';

vi.mock('../../config.js', () => ({
  env: { JWT_SECRET: 'a'.repeat(64) },
}));

const { signAlertTrackingToken, verifyAlertTrackingToken } =
  await import('./trackingToken.js');

const PAYLOAD = {
  orgId: 42,
  userId: 7,
  ruleId: 3,
  ruleKind: 'runway_runs_short' as const,
  fireId: 999,
};

describe('signAlertTrackingToken', () => {
  it('produces a stable base64url string for the same payload', () => {
    const a = signAlertTrackingToken(PAYLOAD);
    const b = signAlertTrackingToken(PAYLOAD);
    expect(a).toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('produces different tokens when any field changes', () => {
    const base = signAlertTrackingToken(PAYLOAD);
    expect(signAlertTrackingToken({ ...PAYLOAD, orgId: 43 })).not.toBe(base);
    expect(signAlertTrackingToken({ ...PAYLOAD, userId: 8 })).not.toBe(base);
    expect(signAlertTrackingToken({ ...PAYLOAD, ruleId: 4 })).not.toBe(base);
    expect(signAlertTrackingToken({ ...PAYLOAD, ruleKind: 'margin_drops' })).not.toBe(base);
    expect(signAlertTrackingToken({ ...PAYLOAD, fireId: 1000 })).not.toBe(base);
  });
});

describe('verifyAlertTrackingToken', () => {
  it('round-trips a valid token', () => {
    const token = signAlertTrackingToken(PAYLOAD);
    expect(verifyAlertTrackingToken(token)).toEqual(PAYLOAD);
  });

  it('returns null for tampered signatures', () => {
    const token = signAlertTrackingToken(PAYLOAD);
    const decoded = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
    decoded.sig = decoded.sig.split('').reverse().join('');
    const tampered = Buffer.from(JSON.stringify(decoded), 'utf8').toString('base64url');
    expect(verifyAlertTrackingToken(tampered)).toBeNull();
  });

  it('returns null when payload fields are mutated post-sign', () => {
    const token = signAlertTrackingToken(PAYLOAD);
    const decoded = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
    decoded.fireId = decoded.fireId + 1;
    const swapped = Buffer.from(JSON.stringify(decoded), 'utf8').toString('base64url');
    expect(verifyAlertTrackingToken(swapped)).toBeNull();
  });

  it('returns null for malformed base64', () => {
    expect(verifyAlertTrackingToken('not-base64-?!@')).toBeNull();
    expect(verifyAlertTrackingToken('')).toBeNull();
  });

  it('returns null when payload is not valid JSON', () => {
    const garbage = Buffer.from('this is not json', 'utf8').toString('base64url');
    expect(verifyAlertTrackingToken(garbage)).toBeNull();
  });

  it('returns null when required fields are missing', () => {
    const noSig = Buffer.from(JSON.stringify({ orgId: 1, userId: 2, ruleId: 3, ruleKind: 'x', fireId: 4 }), 'utf8')
      .toString('base64url');
    expect(verifyAlertTrackingToken(noSig)).toBeNull();

    const noFireId = Buffer.from(
      JSON.stringify({ orgId: 1, userId: 2, ruleId: 3, ruleKind: 'x', sig: 'abc' }),
      'utf8',
    ).toString('base64url');
    expect(verifyAlertTrackingToken(noFireId)).toBeNull();
  });

  it('returns null when types are wrong (string fireId)', () => {
    const wrongType = Buffer.from(
      JSON.stringify({ orgId: 1, userId: 2, ruleId: 3, ruleKind: 'x', fireId: '4', sig: 'abc' }),
      'utf8',
    ).toString('base64url');
    expect(verifyAlertTrackingToken(wrongType)).toBeNull();
  });

  it('uses constant-time comparison (sigs of differing length return null safely)', () => {
    const decoded = { ...PAYLOAD, sig: 'short' };
    const truncated = Buffer.from(JSON.stringify(decoded), 'utf8').toString('base64url');
    expect(verifyAlertTrackingToken(truncated)).toBeNull();
  });

  it('rejects oversized tokens before parsing (soft DOS guard)', () => {
    const oversized = 'a'.repeat(513);
    expect(verifyAlertTrackingToken(oversized)).toBeNull();
  });
});

// Every test above signs and verifies through the module's own functions, so the
// purpose prefix cancels out: change PURPOSE from 'alert:track' to anything else
// and both halves move together and the round trip still passes. muteToken.ts
// has an explicit test for the equivalent guard; this one did not.
//
// Rebuilding the signature here with the prefix written out is what pins it. It
// is the only reason a digest tracking token, which uses the same HMAC scheme
// and the same secret, cannot be replayed against this verifier.
describe('purpose prefix isolation', () => {
  const SECRET = 'a'.repeat(64);

  function tokenSignedWith(purpose: string) {
    const sig = createHmac('sha256', SECRET)
      .update(
        `${purpose}:${PAYLOAD.orgId}:${PAYLOAD.userId}:${PAYLOAD.ruleId}:${PAYLOAD.ruleKind}:${PAYLOAD.fireId}`,
      )
      .digest('base64url');
    return Buffer.from(JSON.stringify({ ...PAYLOAD, sig }), 'utf8').toString('base64url');
  }

  it("accepts a signature built with the 'alert:track' prefix", () => {
    expect(verifyAlertTrackingToken(tokenSignedWith('alert:track'))).toEqual(PAYLOAD);
  });

  it.each(['digest:track', 'alert:mute', 'unsubscribe', 'track', ''])(
    'rejects a signature built with the %s prefix',
    (purpose) => {
      expect(verifyAlertTrackingToken(tokenSignedWith(purpose))).toBeNull();
    },
  );
});
