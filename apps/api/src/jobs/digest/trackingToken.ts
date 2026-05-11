import { createHmac, timingSafeEqual } from 'node:crypto';

import { env } from '../../config.js';

// Purpose prefix in the HMAC input prevents cross-context reuse: an
// unsubscribe token (purpose 'unsubscribe') cannot be replayed as a tracking
// token, because the signature is bound to the literal 'digest:track:'.
//
// Three fields (userId, orgId, weekStart) so the open-pixel and click handlers
// can recover full context from the URL alone, without a server lookup. The
// digest message lives in the recipient's inbox indefinitely, so token
// lifetime is also indefinite, rotating tokens would orphan in-flight digests.
const PURPOSE = 'digest:track';

export interface DigestTrackingPayload {
  userId: number;
  orgId: number;
  weekStart: string;
}

interface SignedPayload extends DigestTrackingPayload {
  sig: string;
}

function sign({ userId, orgId, weekStart }: DigestTrackingPayload): string {
  return createHmac('sha256', env.JWT_SECRET)
    .update(`${PURPOSE}:${userId}:${orgId}:${weekStart}`)
    .digest('base64url');
}

export function signDigestTrackingToken(payload: DigestTrackingPayload): string {
  const signed: SignedPayload = { ...payload, sig: sign(payload) };
  return Buffer.from(JSON.stringify(signed), 'utf8').toString('base64url');
}

function isSignedPayload(value: unknown): value is SignedPayload {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.userId === 'number' &&
    typeof v.orgId === 'number' &&
    typeof v.weekStart === 'string' &&
    typeof v.sig === 'string'
  );
}

// Real tokens encode {userId, orgId, weekStart, sig} plus base64 overhead, well
// under 256 bytes. 512 is a generous ceiling that still rejects pathological
// inputs (multi-KB JSON parsing on every pixel hit is wasteful + a soft DOS
// surface).
const MAX_TOKEN_LENGTH = 512;

export function verifyDigestTrackingToken(token: string): DigestTrackingPayload | null {
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

  const { userId, orgId, weekStart, sig } = decoded;
  const expected = sign({ userId, orgId, weekStart });
  const providedBuf = Buffer.from(sig, 'base64url');
  const expectedBuf = Buffer.from(expected, 'base64url');
  if (providedBuf.length !== expectedBuf.length) return null;
  if (!timingSafeEqual(providedBuf, expectedBuf)) return null;

  return { userId, orgId, weekStart };
}
