import { createHmac } from 'node:crypto';

import { JWT_SECRET } from './config';

// Mirrors the signing in apps/api/src/jobs/alerts/muteToken.ts and
// apps/api/src/jobs/digest/unsubscribeToken.ts. Duplicated rather than
// imported: e2e/tsconfig.json covers only e2e/, and reaching into apps/api
// would pull config.ts and its whole validated environment along with it.
//
// Duplication means this can drift from the real scheme, and nothing in the
// accessibility scans would notice: those pages verify a token when the
// recipient clicks confirm, not on load, so the idle card renders for any
// string in the path. Checked by mutation, a deliberately wrong purpose
// prefix still leaves all six scans green. The tokens are real because a
// recipient's URL is real, not because the scans test them.
function sign(purpose: string, id: number): string {
  return createHmac('sha256', JWT_SECRET).update(`${purpose}:${id}`).digest('base64url');
}

export function signMuteToken(ruleId: number): string {
  return `${ruleId}.${sign('mute-rule', ruleId)}`;
}

export function signUnsubscribeToken(userId: number): string {
  return `${userId}.${sign('unsubscribe', userId)}`;
}
