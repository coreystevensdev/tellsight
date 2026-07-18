import { createHmac, timingSafeEqual } from 'node:crypto';

import type { AlertRuleKind } from 'shared/schemas';
import { env } from '../../config.js';

// Same base64url-JSON-plus-HMAC scheme as digest/trackingToken.ts, purpose-
// prefixed 'alert:track' so a digest tracking token can't be replayed here.
// Carries {ruleId, ruleKind, fireId} instead of digest's {weekStart}: a click
// attributes back to one fire, not a calendar week. Indefinite lifetime, the
// alert email sits in the recipient's inbox indefinitely too.
const PURPOSE = 'alert:track';

export interface AlertTrackingPayload {
  orgId: number;
  userId: number;
  ruleId: number;
  ruleKind: AlertRuleKind;
  fireId: number;
}

interface SignedPayload extends AlertTrackingPayload {
  sig: string;
}

function sign({ orgId, userId, ruleId, ruleKind, fireId }: AlertTrackingPayload): string {
  return createHmac('sha256', env.JWT_SECRET)
    .update(`${PURPOSE}:${orgId}:${userId}:${ruleId}:${ruleKind}:${fireId}`)
    .digest('base64url');
}

export function signAlertTrackingToken(payload: AlertTrackingPayload): string {
  const signed: SignedPayload = { ...payload, sig: sign(payload) };
  return Buffer.from(JSON.stringify(signed), 'utf8').toString('base64url');
}

function isSignedPayload(value: unknown): value is SignedPayload {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.orgId === 'number' &&
    typeof v.userId === 'number' &&
    typeof v.ruleId === 'number' &&
    typeof v.ruleKind === 'string' &&
    typeof v.fireId === 'number' &&
    typeof v.sig === 'string'
  );
}

// Same ceiling as digest's tracking token: real payloads are well under this,
// it just rejects pathological input before a JSON.parse on every click.
const MAX_TOKEN_LENGTH = 512;

export function verifyAlertTrackingToken(token: string): AlertTrackingPayload | null {
  if (!token) return null;
  if (token.length > MAX_TOKEN_LENGTH) return null;

  let decoded: unknown;
  try {
    const json = Buffer.from(token, 'base64url').toString('utf8');
    decoded = JSON.parse(json);
  } catch {
    return null;
  }

  if (!isSignedPayload(decoded)) return null;

  const { orgId, userId, ruleId, ruleKind, fireId, sig } = decoded;
  const expected = sign({ orgId, userId, ruleId, ruleKind, fireId });
  const providedBuf = Buffer.from(sig, 'base64url');
  const expectedBuf = Buffer.from(expected, 'base64url');
  if (providedBuf.length !== expectedBuf.length) return null;
  if (!timingSafeEqual(providedBuf, expectedBuf)) return null;

  return { orgId, userId, ruleId, ruleKind: ruleKind as AlertRuleKind, fireId };
}
