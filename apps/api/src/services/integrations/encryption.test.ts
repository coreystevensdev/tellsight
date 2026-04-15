import { createDecipheriv } from 'node:crypto';

import { describe, it, expect, vi } from 'vitest';

const TEST_KEY = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2';
const WRONG_KEY = 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';

vi.mock('../../config.js', () => ({
  env: { ENCRYPTION_KEY: TEST_KEY },
}));

const { encrypt, decrypt } = await import('./encryption.js');

describe('encryption', () => {
  it('round-trips plaintext through encrypt and decrypt', () => {
    const plaintext = 'oauth-refresh-token-abc123';
    const encrypted = encrypt(plaintext);
    expect(decrypt(encrypted)).toBe(plaintext);
  });

  it('produces different ciphertexts for the same input', () => {
    const plaintext = 'same-input';
    const a = encrypt(plaintext);
    const b = encrypt(plaintext);
    expect(a).not.toBe(b);
  });

  it('handles empty strings', () => {
    const encrypted = encrypt('');
    expect(decrypt(encrypted)).toBe('');
  });

  it('handles long strings (10KB)', () => {
    const plaintext = 'x'.repeat(10_000);
    const encrypted = encrypt(plaintext);
    expect(decrypt(encrypted)).toBe(plaintext);
  });

  it('handles unicode', () => {
    const plaintext = 'token-with-emoji-🔑-and-日本語';
    const encrypted = encrypt(plaintext);
    expect(decrypt(encrypted)).toBe(plaintext);
  });

  it('rejects tampered ciphertext', () => {
    const encrypted = encrypt('secret');
    const parts = encrypted.split(':') as [string, string, string];
    const buf = Buffer.from(parts[2], 'base64');
    buf[0]! ^= 0xff;
    const tampered = `${parts[0]}:${parts[1]}:${buf.toString('base64')}`;
    expect(() => decrypt(tampered)).toThrow();
  });

  it('rejects tampered auth tag', () => {
    const encrypted = encrypt('secret');
    const parts = encrypted.split(':') as [string, string, string];
    const buf = Buffer.from(parts[1], 'base64');
    buf[0]! ^= 0xff;
    const tampered = `${parts[0]}:${buf.toString('base64')}:${parts[2]}`;
    expect(() => decrypt(tampered)).toThrow();
  });

  it('rejects invalid format (missing segments)', () => {
    expect(() => decrypt('just-one-segment')).toThrow('Invalid encrypted format');
    expect(() => decrypt('two:segments')).toThrow('Invalid encrypted format');
  });

  it('rejects decryption with wrong key', () => {
    const encrypted = encrypt('secret');

    const parts = encrypted.split(':') as [string, string, string];
    const iv = Buffer.from(parts[0], 'base64');
    const authTag = Buffer.from(parts[1], 'base64');
    const ciphertext = Buffer.from(parts[2], 'base64');
    const wrongKey = Buffer.from(WRONG_KEY, 'hex');

    const decipher = createDecipheriv('aes-256-gcm', wrongKey, iv);
    decipher.setAuthTag(authTag);
    expect(() => {
      decipher.update(ciphertext);
      decipher.final();
    }).toThrow();
  });

  it('outputs colon-delimited base64 segments', () => {
    const encrypted = encrypt('check-format');
    const parts = encrypted.split(':');
    expect(parts).toHaveLength(3);
    for (const part of parts) {
      expect(() => Buffer.from(part, 'base64')).not.toThrow();
      expect(Buffer.from(part, 'base64').length).toBeGreaterThan(0);
    }
  });
});
