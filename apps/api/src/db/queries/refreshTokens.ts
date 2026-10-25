import { eq, and, isNull, gt } from 'drizzle-orm';
import { db, type DbTransaction } from '../../lib/db.js';
import { refreshTokens } from '../schema.js';

export async function createRefreshToken(
  data: {
    tokenHash: string;
    userId: number;
    orgId: number;
    expiresAt: Date;
  },
  client: typeof db | DbTransaction,
) {
  const [token] = await client.insert(refreshTokens).values(data).returning();
  if (!token) throw new Error('Insert failed to return refresh token');
  return token;
}

export async function findByHash(
  tokenHash: string,
  client: typeof db | DbTransaction,
) {
  return client.query.refreshTokens.findFirst({
    where: and(
      eq(refreshTokens.tokenHash, tokenHash),
      isNull(refreshTokens.revokedAt),
      gt(refreshTokens.expiresAt, new Date()),
    ),
  });
}

/** Looks up a token by hash regardless of revocation status, used for reuse detection */
export async function findAnyByHash(
  tokenHash: string,
  client: typeof db | DbTransaction,
) {
  return client.query.refreshTokens.findFirst({
    where: eq(refreshTokens.tokenHash, tokenHash),
  });
}

/**
 * Returns the row on success and undefined when the token was already revoked.
 * The `isNull` predicate makes this a compare-and-swap: exactly one of several
 * concurrent callers can flip `revoked_at` away from NULL, so the others learn
 * they lost instead of each overwriting the timestamp and minting a successor
 * of their own. Callers must check the result. See DW-216.
 */
export async function revokeToken(
  tokenId: number,
  client: typeof db | DbTransaction,
) {
  const [token] = await client
    .update(refreshTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(refreshTokens.id, tokenId), isNull(refreshTokens.revokedAt)))
    .returning();
  return token;
}

/** Cross-org revocation, revokes all tokens for a user across all orgs (security: full logout) */
export async function revokeAllForUser(
  userId: number,
  client: typeof db | DbTransaction,
) {
  return client
    .update(refreshTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)));
}
