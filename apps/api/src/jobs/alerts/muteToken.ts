import { createHmac, timingSafeEqual } from 'node:crypto';

import { env } from '../../config.js';

// Same HMAC scheme as digest/unsubscribeToken.ts, purpose-prefixed 'mute-rule'
// instead of 'unsubscribe' so a valid unsubscribe or share token can't be
// replayed here. Rule-scoped (not user-scoped): muting stops alerts for one
// rule, not every alert the recipient could ever receive.
const PURPOSE = 'mute-rule';

function sign(ruleId: number): string {
  return createHmac('sha256', env.JWT_SECRET)
    .update(`${PURPOSE}:${ruleId}`)
    .digest('base64url');
}

export function signMuteToken(ruleId: number): string {
  return `${ruleId}.${sign(ruleId)}`;
}

export function verifyMuteToken(token: string): { ruleId: number } | null {
  const parts = token.split('.');
  if (parts.length !== 2) return null;

  const [ruleIdStr, providedSig] = parts as [string, string];
  const ruleId = Number.parseInt(ruleIdStr, 10);
  if (!Number.isFinite(ruleId) || ruleId <= 0) return null;

  const expectedSig = sign(ruleId);
  const providedBuf = Buffer.from(providedSig);
  const expectedBuf = Buffer.from(expectedSig);
  if (providedBuf.length !== expectedBuf.length) return null;
  if (!timingSafeEqual(providedBuf, expectedBuf)) return null;

  return { ruleId };
}
