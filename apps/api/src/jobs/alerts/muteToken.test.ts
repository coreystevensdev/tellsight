import { describe, it, expect, vi } from 'vitest';

vi.mock('../../config.js', () => ({
  env: { JWT_SECRET: 'a'.repeat(64) },
}));

const { signMuteToken, verifyMuteToken } = await import('./muteToken.js');

describe('signMuteToken', () => {
  it('produces a token with ruleId and HMAC parts', () => {
    const token = signMuteToken(7);
    const parts = token.split('.');
    expect(parts).toHaveLength(2);
    expect(parts[0]).toBe('7');
    expect(parts[1]?.length).toBeGreaterThan(0);
  });

  it('produces stable output for the same ruleId', () => {
    expect(signMuteToken(7)).toBe(signMuteToken(7));
  });

  it('produces different tokens for different rules', () => {
    expect(signMuteToken(7)).not.toBe(signMuteToken(8));
  });
});

describe('verifyMuteToken', () => {
  it('round-trips a signed token', () => {
    const token = signMuteToken(42);
    expect(verifyMuteToken(token)).toEqual({ ruleId: 42 });
  });

  it('rejects malformed tokens', () => {
    expect(verifyMuteToken('not-a-token')).toBeNull();
    expect(verifyMuteToken('1.2.3')).toBeNull();
    expect(verifyMuteToken('')).toBeNull();
  });

  it('rejects non-positive rule IDs', () => {
    const malformed = `0.${signMuteToken(1).split('.')[1]}`;
    expect(verifyMuteToken(malformed)).toBeNull();
    const negative = `-1.${signMuteToken(1).split('.')[1]}`;
    expect(verifyMuteToken(negative)).toBeNull();
  });

  it('rejects tokens with tampered signatures', () => {
    const token = signMuteToken(7);
    const [ruleId, sig] = token.split('.');
    const tampered = `${ruleId}.${sig!.split('').reverse().join('')}`;
    expect(verifyMuteToken(tampered)).toBeNull();
  });

  it('rejects tokens with the wrong ruleId in the prefix', () => {
    const token = signMuteToken(7);
    const [, sig] = token.split('.');
    const swapped = `8.${sig}`;
    expect(verifyMuteToken(swapped)).toBeNull();
  });

  it('rejects an unsubscribe token replayed here (purpose prefix isolation)', async () => {
    // A digest unsubscribe token for the same numeric id must not verify as
    // a mute token, even though both schemes share the HMAC construction.
    const { signUnsubscribeToken } = await import('../digest/unsubscribeToken.js');
    const unsubscribeToken = signUnsubscribeToken(7);
    expect(verifyMuteToken(unsubscribeToken)).toBeNull();
  });

  it('uses constant-time comparison (sigs of differing length return null safely)', () => {
    expect(verifyMuteToken('7.short')).toBeNull();
  });
});
