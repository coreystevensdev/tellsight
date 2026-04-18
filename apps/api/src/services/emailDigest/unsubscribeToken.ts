import { createHmac, timingSafeEqual } from 'node:crypto';

import { env } from '../../config.js';

// Purpose prefix in the HMAC input prevents cross-context reuse — a valid access
// token or share token cannot be replayed as an unsubscribe token, because the
// signature is bound to the literal string 'unsubscribe:'.
const PURPOSE = 'unsubscribe';

function sign(userId: number, orgId: number): string {
  return createHmac('sha256', env.JWT_SECRET)
    .update(`${PURPOSE}:${userId}.${orgId}`)
    .digest('base64url');
}

export function signUnsubscribeToken(userId: number, orgId: number): string {
  return `${userId}.${orgId}.${sign(userId, orgId)}`;
}

export function verifyUnsubscribeToken(token: string): { userId: number; orgId: number } | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const [userIdStr, orgIdStr, providedSig] = parts as [string, string, string];
  const userId = Number.parseInt(userIdStr, 10);
  const orgId = Number.parseInt(orgIdStr, 10);
  if (!Number.isFinite(userId) || !Number.isFinite(orgId) || userId <= 0 || orgId <= 0) return null;

  const expectedSig = sign(userId, orgId);
  const providedBuf = Buffer.from(providedSig);
  const expectedBuf = Buffer.from(expectedSig);
  if (providedBuf.length !== expectedBuf.length) return null;
  if (!timingSafeEqual(providedBuf, expectedBuf)) return null;

  return { userId, orgId };
}
