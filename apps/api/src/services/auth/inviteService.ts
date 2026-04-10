import { randomBytes, createHash } from 'node:crypto';
import { logger } from '../../lib/logger.js';
import { ValidationError, NotFoundError } from '../../lib/appError.js';
import * as orgInvitesQueries from '../../db/queries/orgInvites.js';
import * as userOrgsQueries from '../../db/queries/userOrgs.js';
import { db, dbAdmin, type DbTransaction } from '../../lib/db.js';
import { INVITES } from 'shared/constants';

export async function getActiveInvitesForOrg(
  orgId: number,
  client?: typeof db | DbTransaction,
) {
  return orgInvitesQueries.getActiveInvites(orgId, client);
}

function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

export async function generateInvite(
  orgId: number,
  createdBy: number,
  expiresInDays?: number,
  client?: typeof db | DbTransaction,
) {
  const raw = randomBytes(INVITES.TOKEN_BYTES).toString('hex');
  const tokenHash = hashToken(raw);

  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + (expiresInDays ?? INVITES.DEFAULT_EXPIRY_DAYS));

  const invite = await orgInvitesQueries.createInvite(orgId, tokenHash, createdBy, expiresAt, client);

  logger.info({ orgId, inviteId: invite.id }, 'Invite link generated');

  return { token: raw, expiresAt: invite.expiresAt };
}

/** Public invite validation — uses dbAdmin because there's no authenticated user to set RLS context */
export async function validateInviteToken(token: string) {
  const tokenHash = hashToken(token);
  const invite = await orgInvitesQueries.findByTokenHash(tokenHash, dbAdmin);

  if (!invite) {
    throw new NotFoundError('Invite not found');
  }

  if (invite.usedAt) {
    throw new ValidationError('This invite link has already been used');
  }

  if (invite.expiresAt < new Date()) {
    throw new ValidationError('This invite link has expired — ask the org owner for a new one');
  }

  return invite;
}

/** Invite redemption happens during OAuth callback — no RLS context, uses dbAdmin */
export async function redeemInvite(inviteId: number, orgId: number, userId: number) {
  const existing = await userOrgsQueries.findMembership(orgId, userId, dbAdmin);
  if (existing) {
    await orgInvitesQueries.markUsed(inviteId, userId, dbAdmin);
    logger.info({ orgId, userId }, 'Invite redeemed by existing member — skipped');
    return { alreadyMember: true };
  }

  await userOrgsQueries.addMember(orgId, userId, 'member', dbAdmin);
  await orgInvitesQueries.markUsed(inviteId, userId, dbAdmin);

  logger.info({ orgId, userId, inviteId }, 'Invite redeemed — user joined org');
  return { alreadyMember: false };
}
