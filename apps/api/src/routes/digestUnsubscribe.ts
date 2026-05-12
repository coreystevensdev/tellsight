import { Router } from 'express';
import type { Response } from 'express';

import { digestPreferencesQueries } from '../db/queries/index.js';
import { dbAdmin } from '../lib/db.js';
import { verifyUnsubscribeToken } from '../jobs/digest/unsubscribeToken.js';
import { logger } from '../lib/logger.js';

export const publicDigestUnsubscribeRouter = Router();

// POST keeps the operation out of GET-prefetch scope (some email clients prefetch
// links for previews). Idempotent: unsubscribing an already-opted-out user is a
// no-op. The Next.js page at /unsubscribe/digest/[token] calls this.
//
// User-scoped token (one arg): one click stops all digests across every org
// membership.
publicDigestUnsubscribeRouter.post('/digest/unsubscribe/:token', async (req, res: Response) => {
  const { token } = req.params;
  const verified = verifyUnsubscribeToken(token ?? '');

  if (!verified) {
    logger.warn({ tokenPrefix: (token ?? '').slice(0, 8) }, 'Unsubscribe token invalid or tampered');
    res.status(400).json({
      error: { code: 'INVALID_TOKEN', message: 'This unsubscribe link has expired or is invalid.' },
    });
    return;
  }

  await digestPreferencesQueries.upsertDefaults(verified.userId, dbAdmin);
  await digestPreferencesQueries.markUnsubscribed(verified.userId, dbAdmin);

  logger.info(
    { userId: verified.userId },
    'User unsubscribed from digest via email link',
  );

  res.json({ data: { unsubscribed: true } });
});
