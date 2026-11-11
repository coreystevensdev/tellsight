import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword } from './passwordService.js';

describe('passwordService', () => {
  it('hashes a password and verifies the correct password against it', async () => {
    const hash = await hashPassword('correct-horse-battery-staple');
    const valid = await verifyPassword('correct-horse-battery-staple', hash);
    expect(valid).toBe(true);
  });

  it('rejects an incorrect password', async () => {
    const hash = await hashPassword('correct-horse-battery-staple');
    const valid = await verifyPassword('wrong-password', hash);
    expect(valid).toBe(false);
  });

  it('produces a different hash each time, salted', async () => {
    const hashA = await hashPassword('same-password');
    const hashB = await hashPassword('same-password');
    expect(hashA).not.toBe(hashB);
  });

  it('rejects a malformed stored hash instead of throwing', async () => {
    const valid = await verifyPassword('anything', 'not-a-real-hash');
    expect(valid).toBe(false);
  });

  // 'not-a-real-hash' has no colon, so the split guard catches it and the length
  // check below never runs. This one splits fine and is simply too short:
  // timingSafeEqual throws on a length mismatch, which would turn a wrong
  // password into a 500 on every login for that account, not a clean failure.
  it('rejects a truncated stored hash instead of throwing', async () => {
    const valid = await verifyPassword('anything', 'aa:bb');

    expect(valid).toBe(false);
  });
});
