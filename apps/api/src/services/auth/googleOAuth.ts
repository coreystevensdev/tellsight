import { createRemoteJWKSet, jwtVerify } from 'jose';
import { randomBytes } from 'node:crypto';
import { env } from '../../config.js';
import { logger } from '../../lib/logger.js';
import { AuthenticationError, ExternalServiceError } from '../../lib/appError.js';
import * as usersQueries from '../../db/queries/users.js';
import * as orgsQueries from '../../db/queries/orgs.js';
import * as userOrgsQueries from '../../db/queries/userOrgs.js';
import { dbAdmin } from '../../lib/db.js';
import { validateInviteToken, redeemInvite } from './inviteService.js';
import { AUTH } from 'shared/constants';

interface GoogleTokenResponse {
  id_token: string;
  access_token: string;
  token_type: string;
  expires_in: number;
}

interface GoogleUserProfile {
  googleId: string;
  email: string;
  name: string;
  avatarUrl: string | null;
}

const googleJwks = createRemoteJWKSet(new URL(AUTH.GOOGLE_JWKS_URL));

export function generateOAuthState(): string {
  return randomBytes(16).toString('hex');
}

export function buildGoogleAuthUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: `${env.APP_URL}/callback`,
    response_type: 'code',
    scope: AUTH.GOOGLE_SCOPES,
    state,
    access_type: 'offline',
    prompt: 'select_account',
  });

  return `${AUTH.GOOGLE_AUTH_URL}?${params.toString()}`;
}

export async function exchangeCodeForTokens(code: string): Promise<GoogleTokenResponse> {
  const response = await fetch(AUTH.GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: `${env.APP_URL}/callback`,
      grant_type: 'authorization_code',
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    logger.error({ status: response.status, body: errorBody }, 'Google token exchange failed');
    throw new ExternalServiceError('Google OAuth', { status: response.status });
  }

  return response.json() as Promise<GoogleTokenResponse>;
}

export async function verifyGoogleIdToken(idToken: string): Promise<GoogleUserProfile> {
  try {
    const { payload } = await jwtVerify(idToken, googleJwks, {
      audience: env.GOOGLE_CLIENT_ID,
      issuer: ['https://accounts.google.com', 'accounts.google.com'],
    });

    const email = payload.email as string | undefined;
    const name = payload.name as string | undefined;
    const sub = payload.sub;
    const picture = payload.picture as string | undefined;

    if (!sub || !email) {
      throw new AuthenticationError('Google ID token missing required claims');
    }

    return {
      googleId: sub,
      email,
      name: name ?? email.split('@')[0] ?? email,
      avatarUrl: picture ?? null,
    };
  } catch (err) {
    if (err instanceof AuthenticationError) throw err;
    logger.error({ err }, 'Google ID token verification failed');
    throw new AuthenticationError('Invalid Google ID token');
  }
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
}

async function generateUniqueSlug(name: string): Promise<string> {
  const base = slugify(name) || 'org';
  const slug = `${base}-org`;

  const existing = await orgsQueries.findOrgBySlug(slug);
  if (!existing) return slug;

  for (let attempt = 0; attempt < 3; attempt++) {
    const suffix = randomBytes(2).toString('hex');
    const candidateSlug = `${base}-org-${suffix}`;
    const conflict = await orgsQueries.findOrgBySlug(candidateSlug);
    if (!conflict) return candidateSlug;
  }

  // Fallback: use full random slug
  return `org-${randomBytes(4).toString('hex')}`;
}

export async function handleGoogleCallback(code: string, inviteToken?: string) {
  const tokens = await exchangeCodeForTokens(code);
  const profile = await verifyGoogleIdToken(tokens.id_token);

  // if invite token provided, validate it upfront before touching user records
  let invite: Awaited<ReturnType<typeof validateInviteToken>> | null = null;
  if (inviteToken) {
    invite = await validateInviteToken(inviteToken);
  }

  const existingUser = await usersQueries.findUserByGoogleId(profile.googleId);

  if (existingUser) {
    await usersQueries.updateUser(existingUser.id, {
      name: profile.name,
      avatarUrl: profile.avatarUrl ?? undefined,
    });

    // invited user, redeem invite, then use invite's org as primary
    if (invite) {
      await redeemInvite(invite.id, invite.orgId, existingUser.id);
      const membership = await userOrgsQueries.findMembership(invite.orgId, existingUser.id, dbAdmin);
      if (!membership) throw new AuthenticationError('Failed to join organization');

      logger.info({ userId: existingUser.id, orgId: invite.orgId }, 'Existing user joined org via invite');

      return {
        user: existingUser,
        org: invite.org,
        membership,
        isNewUser: false,
      };
    }

    const memberships = await userOrgsQueries.getUserOrgs(existingUser.id, dbAdmin);
    if (memberships.length === 0) {
      throw new AuthenticationError('User has no organization membership');
    }

    const primaryMembership = memberships[0]!;
    logger.info({ userId: existingUser.id }, 'Returning user authenticated via Google OAuth');

    return {
      user: existingUser,
      org: primaryMembership.org,
      membership: primaryMembership,
      isNewUser: false,
    };
  }

  // new user
  const user = await usersQueries.createUser({
    email: profile.email,
    name: profile.name,
    googleId: profile.googleId,
    avatarUrl: profile.avatarUrl ?? undefined,
  });

  // invited new user, join the invite's org, skip auto-org creation
  if (invite) {
    await redeemInvite(invite.id, invite.orgId, user.id);
    const membership = await userOrgsQueries.findMembership(invite.orgId, user.id, dbAdmin);
    if (!membership) throw new AuthenticationError('Failed to join organization');

    logger.info({ userId: user.id, orgId: invite.orgId }, 'New user registered via invite');

    return { user, org: invite.org, membership, isNewUser: true };
  }

  // no invite, default behavior: create org, user becomes owner
  const orgName = `${profile.name}'s Organization`;
  const slug = await generateUniqueSlug(profile.name);
  const org = await orgsQueries.createOrg({ name: orgName, slug });
  const membership = await userOrgsQueries.addMember(org.id, user.id, 'owner', dbAdmin);

  logger.info({ userId: user.id, orgId: org.id, slug }, 'New user registered via Google OAuth');

  return { user, org, membership, isNewUser: true };
}
