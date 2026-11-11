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
const TTL_SECONDS = 10 * 60;

type Provider = 'quickbooks' | 'shopify' | 'square';

export interface OAuthFlowBinding {
  orgId: number;
  userId: number;
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
    return { orgId: parsed.orgId as number, userId: parsed.userId as number };
  } catch {
    return null;
  }
}
