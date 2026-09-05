import { describe, it, expect, vi, beforeEach } from 'vitest';

const TEST_KEY = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2';
const WRONG_KEY = 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';

// getKey() reads env.ENCRYPTION_KEY on every call rather than caching it, so a
// getter here lets a test rotate the key between encrypt and decrypt and still
// go through production's own key path.
const activeKey = vi.hoisted(() => ({ value: '' }));

vi.mock('../../config.js', () => ({
  env: {
    get ENCRYPTION_KEY() {
      return activeKey.value;
    },
  },
}));

const { encrypt, decrypt } = await import('./encryption.js');

describe('encryption', () => {
  beforeEach(() => {
    activeKey.value = TEST_KEY;
  });

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

  // Was building its own decipher with createDecipheriv and never calling
  // decrypt, so it proved that Node's AES-GCM rejects a wrong key, which was
  // never in question. It would have passed with getKey() returning
  // Buffer.alloc(32). Rotating the key and calling production decrypt tests the
  // thing that can actually break: key handling on our side.
  it('rejects decryption under a different key', () => {
    const encrypted = encrypt('secret');

    activeKey.value = WRONG_KEY;
    expect(() => decrypt(encrypted)).toThrow();

    // And is not simply broken for everything: the original key still works.
    activeKey.value = TEST_KEY;
    expect(decrypt(encrypted)).toBe('secret');
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

// The tests above tamper with the value of each segment; none touched its
// length, so both length guards were unasserted and deleting either left the
// whole API suite green.
//
// That matters because Node does not enforce these itself. createDecipheriv
// accepts a 16-byte IV for GCM, and setAuthTag accepts a 4-byte tag and
// decrypts successfully, with only a deprecation warning. So this guard is the
// only thing standing between 2^128 and 2^32 forgery resistance: an attacker
// who can present a short tag needs about four billion attempts rather than a
// number with 39 digits.
describe('encryption segment lengths', () => {
  function reassemble(encrypted: string, index: number, replace: (b: Buffer) => Buffer) {
    const parts = encrypted.split(':') as [string, string, string];
    parts[index] = replace(Buffer.from(parts[index]!, 'base64')).toString('base64');
    return parts.join(':');
  }

  it.each([
    ['truncated to 4 bytes', (b: Buffer) => b.subarray(0, 4)],
    ['truncated to 15 bytes, one short', (b: Buffer) => b.subarray(0, 15)],
    ['a single byte', (b: Buffer) => b.subarray(0, 1)],
    ['empty', () => Buffer.alloc(0)],
    ['padded to 17 bytes', (b: Buffer) => Buffer.concat([b, Buffer.alloc(1)])],
  ])('rejects an auth tag %s', (_label, mangle) => {
    const encrypted = encrypt('quickbooks-refresh-token');

    expect(() => decrypt(reassemble(encrypted, 1, mangle))).toThrow(/Invalid auth tag length/);
  });

  it.each([
    ['truncated to 4 bytes', (b: Buffer) => b.subarray(0, 4)],
    ['empty', () => Buffer.alloc(0)],
    ['padded to 16 bytes, which GCM would otherwise accept', (b: Buffer) =>
      Buffer.concat([b, Buffer.alloc(4)])],
  ])('rejects an IV %s', (_label, mangle) => {
    const encrypted = encrypt('quickbooks-refresh-token');

    expect(() => decrypt(reassemble(encrypted, 0, mangle))).toThrow(/Invalid IV length/);
  });

  // The message names the length rather than being a generic crypto failure,
  // which is how we know the guard rejected it and not the cipher.
  it('reports the expected and actual length', () => {
    const encrypted = encrypt('token');

    expect(() => decrypt(reassemble(encrypted, 1, (b) => b.subarray(0, 4)))).toThrow(
      'Invalid auth tag length: expected 16, got 4',
    );
    expect(() => decrypt(reassemble(encrypted, 0, (b) => b.subarray(0, 4)))).toThrow(
      'Invalid IV length: expected 12, got 4',
    );
  });

  it('still accepts segments of exactly the right length', () => {
    const encrypted = encrypt('token');
    const [iv, tag] = encrypted.split(':') as [string, string, string];

    expect(Buffer.from(iv, 'base64')).toHaveLength(12);
    expect(Buffer.from(tag, 'base64')).toHaveLength(16);
    expect(decrypt(encrypted)).toBe('token');
  });
});
