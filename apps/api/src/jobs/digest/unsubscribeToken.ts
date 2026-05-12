import { createHmac, timingSafeEqual } from 'node:crypto';

import { env } from '../../config.js';

// Purpose prefix in the HMAC input prevents cross-context reuse: a valid
// access token or share token cannot be replayed as an unsubscribe token,
// because the signature is bound to the literal string 'unsubscribe:'.
//
// User-scoped (not per-org): digest_preferences are keyed on user_id, so one
// click stops all digests across every org membership.
const PURPOSE = 'unsubscribe';

function sign(userId: number): string {
  return createHmac('sha256', env.JWT_SECRET)
    .update(`${PURPOSE}:${userId}`)
    .digest('base64url');
}

export function signUnsubscribeToken(userId: number): string {
  return `${userId}.${sign(userId)}`;
}

export function verifyUnsubscribeToken(token: string): { userId: number } | null {
  const parts = token.split('.');
  if (parts.length !== 2) return null;

  const [userIdStr, providedSig] = parts as [string, string];
  const userId = Number.parseInt(userIdStr, 10);
  if (!Number.isFinite(userId) || userId <= 0) return null;

  const expectedSig = sign(userId);
  const providedBuf = Buffer.from(providedSig);
  const expectedBuf = Buffer.from(expectedSig);
  if (providedBuf.length !== expectedBuf.length) return null;
  if (!timingSafeEqual(providedBuf, expectedBuf)) return null;

  return { userId };
}
