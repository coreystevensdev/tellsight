import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import { env } from '../../config.js';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;

function getKey(): Buffer {
  if (!env.ENCRYPTION_KEY) {
    throw new Error('ENCRYPTION_KEY not configured');
  }
  return Buffer.from(env.ENCRYPTION_KEY, 'hex');
}

export function encrypt(plaintext: string): string {
  const key = getKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return [
    iv.toString('base64'),
    authTag.toString('base64'),
    encrypted.toString('base64'),
  ].join(':');
}

export function decrypt(encoded: string): string {
  const parts = encoded.split(':');
  if (parts.length !== 3) {
    throw new Error('Invalid encrypted format, expected iv:authTag:ciphertext');
  }

  const key = getKey();
  const iv = Buffer.from(parts[0]!, 'base64');
  const authTag = Buffer.from(parts[1]!, 'base64');
  const ciphertext = Buffer.from(parts[2]!, 'base64');

  if (iv.length !== IV_BYTES) {
    throw new Error(`Invalid IV length: expected ${IV_BYTES}, got ${iv.length}`);
  }
  if (authTag.length !== AUTH_TAG_BYTES) {
    throw new Error(`Invalid auth tag length: expected ${AUTH_TAG_BYTES}, got ${authTag.length}`);
  }

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);

  return decrypted.toString('utf8');
}
