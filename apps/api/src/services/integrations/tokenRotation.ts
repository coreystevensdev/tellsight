import { integrationConnectionsQueries } from '../../db/queries/index.js';
import { dbAdmin } from '../../lib/db.js';
import { logger } from '../../lib/logger.js';

export interface RotatedTokens {
  encryptedAccessToken: string;
  encryptedRefreshToken: string;
  accessTokenExpiresAt: Date;
}

/**
 * Settles a refresh that raced another one, without a lock.
 *
 * `createQbClient` already collapses concurrent 401s inside one client
 * instance, but a client is built per sync, so a scheduled run and a manual run
 * hold separate instances and can refresh at the same time (DW-283). Two
 * outcomes follow, and they need opposite handling:
 *
 *   - Both calls reach the provider and both succeed. Intuit allows this,
 *     because its previous refresh token keeps working for a grace period. The
 *     second writer must not overwrite the first, or a token the other sync is
 *     already using is replaced mid-flight, so the write is a compare-and-set on
 *     the refresh token it started from and the loser adopts the winner's pair.
 *
 *   - The second call is rejected by the provider, because the first already
 *     invalidated the token. Xero works this way by design. That rejection is
 *     indistinguishable from a real revocation at the HTTP layer, and treating
 *     it as one would mark a healthy connection broken and make the owner
 *     reconnect for nothing.
 *
 * Both are resolved by the same question: has the stored refresh token moved
 * since we read it? If it has, somebody else rotated and their pair is the live
 * one. If it has not, the failure was real.
 */
export async function adoptRotatedTokens(
  connectionId: number,
  provider: string,
  startedFrom: string,
): Promise<RotatedTokens | null> {
  const current = await integrationConnectionsQueries.getByIdAndProvider(
    connectionId,
    provider,
    dbAdmin,
  );
  if (!current) return null;
  if (current.encryptedRefreshToken === startedFrom) return null;

  logger.info(
    { connectionId, provider },
    'Another refresh rotated this connection first, adopting its tokens',
  );
  return {
    encryptedAccessToken: current.encryptedAccessToken,
    encryptedRefreshToken: current.encryptedRefreshToken,
    accessTokenExpiresAt: current.accessTokenExpiresAt,
  };
}

/**
 * Stores a freshly rotated pair, or adopts the winner's if another refresh got
 * there first. Returns whichever pair is actually live afterwards.
 */
export async function commitRotatedTokens(
  connectionId: number,
  provider: string,
  startedFrom: string,
  rotated: RotatedTokens,
): Promise<RotatedTokens> {
  const won = await integrationConnectionsQueries.updateTokensIfUnchanged(
    connectionId,
    startedFrom,
    rotated.encryptedAccessToken,
    rotated.encryptedRefreshToken,
    rotated.accessTokenExpiresAt,
    dbAdmin,
  );
  if (won) return rotated;

  const adopted = await adoptRotatedTokens(connectionId, provider, startedFrom);
  if (adopted) return adopted;

  // The compare failed and the stored token still reads as the one we started
  // from, which should not be reachable: the only thing that moves it is a
  // rotation, and a rotation is what would have made the compare fail. Losing
  // the pair we hold is worse than an unexplained write, because the provider
  // has already issued it and will not again.
  logger.warn(
    { connectionId, provider },
    'Token rotation compare-and-set lost without a visible rotation, storing anyway',
  );
  await integrationConnectionsQueries.updateTokens(
    connectionId,
    rotated.encryptedAccessToken,
    rotated.encryptedRefreshToken,
    rotated.accessTokenExpiresAt,
    dbAdmin,
  );
  return rotated;
}
