import { createHash, createHmac, randomBytes } from 'node:crypto';

import { JWT_SECRET } from './config';

// Mirrors the signing in apps/api/src/jobs/alerts/muteToken.ts and
// apps/api/src/jobs/digest/unsubscribeToken.ts. Duplicated rather than
// imported: e2e/tsconfig.json covers only e2e/, and reaching into apps/api
// would pull config.ts and its whole validated environment along with it.
//
// Duplication means this can drift from the real scheme, and the accessibility
// scans using these would not notice: /mute and /unsubscribe verify a token
// when the recipient clicks confirm, not on load, so the idle card renders for
// any string in the path. Checked by mutation, a deliberately wrong purpose
// prefix leaves those scans green. The /share and /invite fixtures below are
// different, those routes resolve on load and their scans do fail on a bad
// token.
function sign(purpose: string, id: number): string {
  return createHmac('sha256', JWT_SECRET).update(`${purpose}:${id}`).digest('base64url');
}

export function signMuteToken(ruleId: number): string {
  return `${ruleId}.${sign('mute-rule', ruleId)}`;
}

export function signUnsubscribeToken(userId: number): string {
  return `${userId}.${sign('unsubscribe', userId)}`;
}

// shares, org_invites and password_reset_tokens all store sha256(raw) and never
// the token itself, so a fixture has to mint the pair the same way apps/api
// does: three separate hashToken definitions there, all identical.
export function mintToken(): { raw: string; hash: string } {
  const raw = randomBytes(32).toString('hex');
  return { raw, hash: createHash('sha256').update(raw).digest('hex') };
}
