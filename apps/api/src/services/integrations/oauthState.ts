import { randomBytes, timingSafeEqual } from 'node:crypto';

import { redis } from '../../lib/redis.js';

// The org an OAuth callback writes to has to come from the server, not from the
// browser. It used to come from a `<provider>_oauth_org_id` cookie that the
// callback read straight into an RLS-bypassing upsert, so editing that cookie
// mid-flow redirected the write to any org id, and ids are sequential. The
// cookies were never signed either: cookieParser is mounted without a secret
// and nothing reads req.signedCookies, so the comment claiming they were signed
// was describing a property the code did not have.
//
// Signing them would have fixed the tampering and left the shape wrong, because
// the userId arrived the same way: checking "is cookie-user a member of
// cookie-org" passes when an attacker sets both. The binding has to live
// somewhere the browser cannot reach.
//
// So: /connect stores orgId and userId under the state it just minted, and
// /callback looks them up by the state the provider echoes back. Reads delete
// the key, so a state is single-use and a replayed callback finds nothing.
//
// The server-side binding alone is not enough, and getting this wrong once is
// why the nonce exists. The binding records the org that *started* a flow, so an
// attacker can start one against their own org and then walk a victim through
// the provider's consent screen with that authUrl. The victim's browser hands us
// the victim's code, we resolve the attacker's binding, and the victim's books
// land in the attacker's org. The old cookie compare did stop that, by accident
// of being a double submit.
//
// nonce restores it without restoring the hole: it is random, it is the only
// thing in the cookie, and it names no org. A flow completes only when the
// browser finishing it is the browser that started it.
const TTL_SECONDS = 10 * 60;

type Provider = 'quickbooks' | 'shopify' | 'square';

export interface OAuthFlowBinding {
  orgId: number;
  userId: number;
  // Matched against the `<provider>_oauth_nonce` cookie at the callback.
  nonce: string;
}

const key = (provider: Provider, state: string) => `oauth:state:${provider}:${state}`;

export async function putOAuthState(
  provider: Provider,
  state: string,
  binding: OAuthFlowBinding,
): Promise<void> {
  await redis.set(key(provider, state), JSON.stringify(binding), 'EX', TTL_SECONDS);
}

// Returns null for an unknown, expired or already-consumed state. Callers must
// treat that as a failed flow rather than falling back to anything.
export async function takeOAuthState(
  provider: Provider,
  state: string | undefined,
): Promise<OAuthFlowBinding | null> {
  if (!state) return null;

  const k = key(provider, state);
  const raw = await redis.get(k);
  await redis.del(k);
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as Partial<OAuthFlowBinding>;
    if (!Number.isInteger(parsed.orgId) || !Number.isInteger(parsed.userId)) return null;
    if (typeof parsed.nonce !== 'string' || parsed.nonce.length === 0) return null;
    return { orgId: parsed.orgId as number, userId: parsed.userId as number, nonce: parsed.nonce };
  } catch {
    return null;
  }
}

export const oauthNonceCookie = (provider: Provider) => `${provider}_oauth_nonce`;

export const newOAuthNonce = () => randomBytes(16).toString('hex');

// Compared against a value the caller is not supposed to know, so length is
// checked first (timingSafeEqual throws on a mismatch) and the rest runs in
// constant time.
export function nonceMatches(fromCookie: string | undefined, expected: string): boolean {
  if (!fromCookie) return false;

  const a = Buffer.from(fromCookie, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;

  return timingSafeEqual(a, b);
}
