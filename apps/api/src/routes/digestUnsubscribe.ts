import { Router } from 'express';
import type { Response } from 'express';

import { userOrgsQueries } from '../db/queries/index.js';
import { verifyUnsubscribeToken } from '../services/emailDigest/unsubscribeToken.js';
import { logger } from '../lib/logger.js';

export const publicDigestUnsubscribeRouter = Router();

// POST keeps the operation out of GET-prefetch scope (some email clients prefetch
// links for previews). Idempotent: unsubscribing an already-opted-out user is a
// no-op. The Next.js page at /unsubscribe/digest/[token] calls this.
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

  await userOrgsQueries.updateDigestOptIn(verified.orgId, verified.userId, false);

  logger.info(
    { orgId: verified.orgId, userId: verified.userId },
    'User unsubscribed from digest via email link',
  );

  res.json({ data: { unsubscribed: true } });
});
