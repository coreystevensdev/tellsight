import { randomBytes, createHash } from 'node:crypto';
import { logger } from '../../lib/logger.js';
import { AuthenticationError, ConflictError, NotFoundError, ValidationError } from '../../lib/appError.js';
import * as usersQueries from '../../db/queries/users.js';
import * as userOrgsQueries from '../../db/queries/userOrgs.js';
import * as passwordResetTokensQueries from '../../db/queries/passwordResetTokens.js';
import * as refreshTokensQueries from '../../db/queries/refreshTokens.js';
import { dbAdmin } from '../../lib/db.js';
import { validateInviteToken, redeemInvite } from './inviteService.js';
import { createOwnerOrgForUser } from './orgOnboarding.js';
import { hashPassword, verifyPassword } from './passwordService.js';
import { PASSWORD_RESET } from 'shared/constants';

function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

export async function signUpWithPassword(
  email: string,
  name: string,
  password: string,
  inviteToken?: string,
) {
  const existing = await usersQueries.findUserByEmail(email);
  if (existing) {
    throw new ConflictError('An account with this email already exists. Try signing in instead.');
  }

  let invite: Awaited<ReturnType<typeof validateInviteToken>> | null = null;
  if (inviteToken) {
    invite = await validateInviteToken(inviteToken);
  }

  const passwordHash = await hashPassword(password);
  const user = await usersQueries.createUser({ email, name, passwordHash });

  if (invite) {
    await redeemInvite(invite.id, invite.orgId, user.id);
    const membership = await userOrgsQueries.findMembership(invite.orgId, user.id, dbAdmin);
    if (!membership) throw new AuthenticationError('Failed to join organization');

    logger.info({ userId: user.id, orgId: invite.orgId }, 'New user registered via invite (password)');
    return { user, org: invite.org, membership, isNewUser: true };
  }

  const { org, membership } = await createOwnerOrgForUser(user.id, name);
  logger.info({ userId: user.id, orgId: org.id, slug: org.slug }, 'New user registered via password sign-up');

  return { user, org, membership, isNewUser: true };
}

export async function logInWithPassword(email: string, password: string) {
  const user = await usersQueries.findUserByEmail(email);

  if (!user || !user.passwordHash) {
    throw new AuthenticationError('Invalid email or password');
  }

  const valid = await verifyPassword(password, user.passwordHash);
  if (!valid) {
    throw new AuthenticationError('Invalid email or password');
  }

  const memberships = await userOrgsQueries.getUserOrgs(user.id, dbAdmin);
  if (memberships.length === 0) {
    throw new AuthenticationError('User has no organization membership');
  }

  const primaryMembership = memberships[0]!;
  logger.info({ userId: user.id }, 'User authenticated via password');

  return { user, org: primaryMembership.org, membership: primaryMembership, isNewUser: false };
}

/** Always succeeds from the caller's perspective, whether or not the email
 * matches an account, so the route can't be used to enumerate registered
 * emails. The email only actually sends when there's a real match. */
export async function requestPasswordReset(email: string): Promise<{ token: string; userId: number } | null> {
  const user = await usersQueries.findUserByEmail(email);
  if (!user) return null;

  const raw = randomBytes(PASSWORD_RESET.TOKEN_BYTES).toString('hex');
  const tokenHash = hashToken(raw);
  const expiresAt = new Date(Date.now() + PASSWORD_RESET.EXPIRY_HOURS * 60 * 60 * 1000);

  await passwordResetTokensQueries.createToken(user.id, tokenHash, expiresAt, dbAdmin);
  logger.info({ userId: user.id }, 'Password reset token generated');

  return { token: raw, userId: user.id };
}

export async function resetPassword(token: string, newPassword: string) {
  const tokenHash = hashToken(token);
  const resetToken = await passwordResetTokensQueries.findByTokenHash(tokenHash, dbAdmin);

  if (!resetToken) {
    throw new NotFoundError('Reset link not found');
  }
  if (resetToken.usedAt) {
    throw new ValidationError('This reset link has already been used');
  }
  if (resetToken.expiresAt < new Date()) {
    throw new ValidationError('This reset link has expired, request a new one');
  }

  const user = await usersQueries.findUserById(resetToken.userId);
  if (!user) {
    throw new NotFoundError('User not found');
  }

  const passwordHash = await hashPassword(newPassword);
  await usersQueries.updateUser(user.id, { passwordHash });
  await passwordResetTokensQueries.markUsed(resetToken.id, dbAdmin);
  // force re-login everywhere, whoever holds the old password shouldn't keep an active session
  await refreshTokensQueries.revokeAllForUser(user.id, dbAdmin);

  const memberships = await userOrgsQueries.getUserOrgs(user.id, dbAdmin);
  if (memberships.length === 0) {
    throw new AuthenticationError('User has no organization membership');
  }

  const primaryMembership = memberships[0]!;
  logger.info({ userId: user.id }, 'Password reset completed');

  return { user, org: primaryMembership.org, membership: primaryMembership };
}
