import { SignJWT, jwtVerify } from 'jose';
import { randomBytes, createHash } from 'node:crypto';
import { env } from '../../config.js';
import { logger } from '../../lib/logger.js';
import { AuthenticationError, RefreshRaceError } from '../../lib/appError.js';
import * as refreshTokensQueries from '../../db/queries/refreshTokens.js';
import * as usersQueries from '../../db/queries/users.js';
import * as userOrgsQueries from '../../db/queries/userOrgs.js';
import { dbAdmin } from '../../lib/db.js';
import { AUTH } from 'shared/constants';
import { jwtPayloadSchema } from 'shared/schemas';
import type { JwtPayload, Role } from 'shared/types';

const JWT_ALG = 'HS256' as const;

function getSecret() {
  return new TextEncoder().encode(env.JWT_SECRET);
}

export async function signAccessToken(payload: {
  userId: number;
  orgId: number;
  role: Role;
  isAdmin: boolean;
}): Promise<string> {
  return new SignJWT({
    org_id: payload.orgId,
    role: payload.role,
    isAdmin: payload.isAdmin,
  })
    .setProtectedHeader({ alg: JWT_ALG })
    .setSubject(String(payload.userId))
    .setIssuedAt()
    .setExpirationTime(AUTH.ACCESS_TOKEN_EXPIRY)
    .sign(getSecret());
}

export async function verifyAccessToken(token: string): Promise<JwtPayload> {
  try {
    const { payload } = await jwtVerify(token, getSecret());
    return jwtPayloadSchema.parse(payload);
  } catch {
    throw new AuthenticationError('Invalid or expired access token');
  }
}

export function generateRefreshToken(): { raw: string; hash: string } {
  const raw = randomBytes(32).toString('hex');
  const hash = createHash('sha256').update(raw).digest('hex');
  return { raw, hash };
}

export async function createTokenPair(
  userId: number,
  orgId: number,
  role: Role,
  isAdmin: boolean,
) {
  const accessToken = await signAccessToken({ userId, orgId, role, isAdmin });
  const { raw, hash } = generateRefreshToken();

  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + AUTH.REFRESH_TOKEN_EXPIRY_DAYS);

  await refreshTokensQueries.createRefreshToken({
    tokenHash: hash,
    userId,
    orgId,
    expiresAt,
  }, dbAdmin);

  logger.info({ userId, orgId }, 'Token pair created');

  return { accessToken, refreshToken: raw };
}

export async function rotateRefreshToken(rawToken: string) {
  const hash = createHash('sha256').update(rawToken).digest('hex');
  const existing = await refreshTokensQueries.findByHash(hash, dbAdmin);

  if (!existing) {
    // Token not valid, check if it was previously revoked (reuse attack detection)
    const revoked = await refreshTokensQueries.findAnyByHash(hash, dbAdmin);
    if (revoked) {
      logger.warn(
        { userId: revoked.userId, tokenHashPrefix: hash.slice(0, 8) },
        'Refresh token reuse detected, revoking all tokens for user',
      );
      await refreshTokensQueries.revokeAllForUser(revoked.userId, dbAdmin);
    }
    throw new AuthenticationError('Invalid refresh token');
  }

  const revoked = await refreshTokensQueries.revokeToken(existing.id, dbAdmin);
  if (!revoked) {
    // The token was live when findByHash read it and was spent in between, so a
    // sibling request won. That is a race, not reuse: reuse means the token was
    // already revoked before this request looked, which is the branch above.
    // Deliberately mints nothing. The winner has set a fresh pair on its own
    // response, and handing a second successor out here is the capability an
    // attacker racing inside this window would want.
    //
    // Its own log line, separate from the reuse warning, because the two need
    // counting separately and conflating them is what made the rate
    // unmeasurable in the first place.
    logger.info(
      { userId: existing.userId, tokenHashPrefix: hash.slice(0, 8) },
      'Refresh token rotation lost a race, no sessions revoked',
    );
    throw new RefreshRaceError();
  }

  const user = await usersQueries.findUserById(existing.userId);
  if (!user) {
    throw new AuthenticationError('User not found');
  }

  const memberships = await userOrgsQueries.getUserOrgs(user.id, dbAdmin);
  const membership = memberships.find((m) => m.orgId === existing.orgId);
  if (!membership) {
    throw new AuthenticationError('Organization membership not found');
  }

  const { accessToken, refreshToken } = await createTokenPair(
    user.id,
    existing.orgId,
    membership.role as Role,
    user.isPlatformAdmin,
  );

  logger.info({ userId: user.id, orgId: existing.orgId }, 'Refresh token rotated');

  return { accessToken, refreshToken, userId: user.id, orgId: existing.orgId };
}
