import { describe, it, expect, vi } from 'vitest';
import { createHmac } from 'node:crypto';

vi.mock('../../config.js', () => ({
  env: { JWT_SECRET: 'a'.repeat(32) },
}));

import { signUnsubscribeToken, verifyUnsubscribeToken } from './unsubscribeToken.js';

describe('unsubscribeToken', () => {
  it('round-trips a valid (userId, orgId) pair', () => {
    const token = signUnsubscribeToken(42, 7);
    const verified = verifyUnsubscribeToken(token);
    expect(verified).toEqual({ userId: 42, orgId: 7 });
  });

  it('rejects a tampered signature', () => {
    const token = signUnsubscribeToken(42, 7);
    const [userId, orgId, sig] = token.split('.');
    // Flip a character in the signature — authentic tokens and tampered tokens
    // differ by at least one base64url character, which fails timing-safe compare.
    const flipped = sig!.slice(0, -1) + (sig!.slice(-1) === 'A' ? 'B' : 'A');
    const tampered = `${userId}.${orgId}.${flipped}`;
    expect(verifyUnsubscribeToken(tampered)).toBeNull();
  });

  it('rejects a tampered orgId (prevents unsubscribing from a different org)', () => {
    const token = signUnsubscribeToken(42, 7);
    const [userId, , sig] = token.split('.');
    const tampered = `${userId}.99.${sig}`;
    expect(verifyUnsubscribeToken(tampered)).toBeNull();
  });

  it('rejects a tampered userId', () => {
    const token = signUnsubscribeToken(42, 7);
    const [, orgId, sig] = token.split('.');
    const tampered = `1.${orgId}.${sig}`;
    expect(verifyUnsubscribeToken(tampered)).toBeNull();
  });

  it('rejects a token with the wrong number of parts', () => {
    expect(verifyUnsubscribeToken('not-a-token')).toBeNull();
    expect(verifyUnsubscribeToken('1.2')).toBeNull();
    expect(verifyUnsubscribeToken('1.2.3.4')).toBeNull();
  });

  it('rejects a token with non-integer IDs', () => {
    expect(verifyUnsubscribeToken('abc.7.somesig')).toBeNull();
    expect(verifyUnsubscribeToken('42.def.somesig')).toBeNull();
    expect(verifyUnsubscribeToken('-1.7.somesig')).toBeNull();
  });

  it('rejects a token signed for a different purpose (domain separation)', () => {
    // A forged signature using the same secret but a different purpose prefix —
    // simulates someone trying to replay a non-unsubscribe HMAC as an
    // unsubscribe token. Purpose prefix keeps contexts separate.
    const forged = createHmac('sha256', 'a'.repeat(32))
      .update('access:42.7')
      .digest('base64url');
    const token = `42.7.${forged}`;
    expect(verifyUnsubscribeToken(token)).toBeNull();
  });

  it('is deterministic — same input produces same token (allows idempotent verification)', () => {
    const token1 = signUnsubscribeToken(42, 7);
    const token2 = signUnsubscribeToken(42, 7);
    expect(token1).toBe(token2);
  });
});
