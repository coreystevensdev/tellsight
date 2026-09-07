import { describe, it, expect, vi } from 'vitest';
import { createHmac } from 'node:crypto';

vi.mock('../../config.js', () => ({
  env: { JWT_SECRET: 'a'.repeat(64) },
}));

const { signUnsubscribeToken, verifyUnsubscribeToken } =
  await import('./unsubscribeToken.js');

describe('signUnsubscribeToken', () => {
  it('produces a token with userId and HMAC parts', () => {
    const token = signUnsubscribeToken(7);
    const parts = token.split('.');
    expect(parts).toHaveLength(2);
    expect(parts[0]).toBe('7');
    expect(parts[1]?.length).toBeGreaterThan(0);
  });

  it('produces stable output for the same userId', () => {
    expect(signUnsubscribeToken(7)).toBe(signUnsubscribeToken(7));
  });

  it('produces different tokens for different users', () => {
    expect(signUnsubscribeToken(7)).not.toBe(signUnsubscribeToken(8));
  });
});

describe('verifyUnsubscribeToken', () => {
  it('round-trips a signed token', () => {
    const token = signUnsubscribeToken(42);
    expect(verifyUnsubscribeToken(token)).toEqual({ userId: 42 });
  });

  it('rejects malformed tokens', () => {
    expect(verifyUnsubscribeToken('not-a-token')).toBeNull();
    expect(verifyUnsubscribeToken('1.2.3')).toBeNull();
    expect(verifyUnsubscribeToken('')).toBeNull();
  });

  it('rejects non-positive user IDs', () => {
    const malformed = `0.${signUnsubscribeToken(1).split('.')[1]}`;
    expect(verifyUnsubscribeToken(malformed)).toBeNull();
    const negative = `-1.${signUnsubscribeToken(1).split('.')[1]}`;
    expect(verifyUnsubscribeToken(negative)).toBeNull();
  });

  it('rejects tokens with tampered signatures', () => {
    const token = signUnsubscribeToken(7);
    const [userId, sig] = token.split('.');
    const tampered = `${userId}.${sig!.split('').reverse().join('')}`;
    expect(verifyUnsubscribeToken(tampered)).toBeNull();
  });

  it('rejects tokens with the wrong userId in the prefix', () => {
    const token = signUnsubscribeToken(7);
    const [, sig] = token.split('.');
    // userId 8 with signature for userId 7, must fail
    const swapped = `8.${sig}`;
    expect(verifyUnsubscribeToken(swapped)).toBeNull();
  });

  it('uses constant-time comparison (sigs of differing length return null safely)', () => {
    expect(verifyUnsubscribeToken('7.short')).toBeNull();
  });
});


// Every test above signs and verifies through this module's own functions, so
// the purpose prefix cancels out: drop it from both halves and the round trip
// still passes. The cross-scheme test that exists has the same blind spot, since
// it signs the other token with that module's real signer, so removing this
// prefix moves only one side and the two literals still differ.
//
// Writing the prefix out by hand is what pins it. Removing `${PURPOSE}:` from
// the HMAC input left all 2,483 API tests green before this block existed.
describe('purpose prefix isolation', () => {
  const SECRET = 'a'.repeat(64);

  function tokenSignedWith(prefixed: string) {
    const sig = createHmac('sha256', SECRET).update(prefixed).digest('base64url');
    return `7.${sig}`;
  }

  it("accepts a signature built with the 'unsubscribe' prefix", () => {
    expect(verifyUnsubscribeToken(tokenSignedWith('unsubscribe:7'))).toEqual({ userId: 7 });
  });

  it.each(['mute-rule', 'alert:track', 'digest:track', 'unsubscribed'])('rejects a signature built with the %s prefix', (other: string) => {
    expect(verifyUnsubscribeToken(tokenSignedWith(`${other}:7`))).toBeNull();
  });

  // What dropping the prefix altogether produces: a signature over the bare id.
  it('rejects a signature over the bare id', () => {
    expect(verifyUnsubscribeToken(tokenSignedWith('7'))).toBeNull();
  });
});
