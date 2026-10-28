import type { Request, Response, Router } from 'express';

import { ANALYTICS_EVENTS, AUDIT_ACTIONS } from 'shared/constants';

import { integrationConnectionsQueries } from '../db/queries/index.js';
import { sessionCookieOptions } from '../lib/cookies.js';
import { logger } from '../lib/logger.js';
import { requireUser } from '../lib/requireUser.js';
import { withRlsContext } from '../lib/rls.js';
import { roleGuard } from '../middleware/roleGuard.js';
import { trackEvent } from '../services/analytics/trackEvent.js';
import { auditAuth } from '../services/audit/auditService.js';
import { decrypt } from '../services/integrations/encryption.js';
import * as squareOAuth from '../services/integrations/square/oauth.js';
import { removeDailySync as removeSquareDailySync } from '../services/integrations/square/scheduler.js';
import { enqueueSyncJob as enqueueSquareSyncJob } from '../services/integrations/square/worker.js';

export function registerSquareIntegrationRoutes(router: Router): void {
  // Unlike Shopify, a Square authorize URL is the same for every seller, so
  // /connect needs nothing from the caller: which merchant is connecting only
  // becomes known when the callback returns a merchant_id.
  router.post('/square/connect', async (req: Request, res: Response) => {
    const user = requireUser(req);
    const orgId = user.org_id;

    const existing = await withRlsContext(orgId, user.isAdmin, (tx) =>
      integrationConnectionsQueries.getByOrgAndProvider(orgId, 'square', tx),
    );
    if (existing) {
      res.status(409).json({
        error: { code: 'ALREADY_CONNECTED', message: 'Square is already connected' },
      });
      return;
    }

    const { authUrl, state } = squareOAuth.generateAuthUrl();
    const cookieOpts = sessionCookieOptions(10 * 60);

    res.cookie('square_oauth_state', state, cookieOpts);
    res.cookie('square_oauth_org_id', String(orgId), cookieOpts);
    res.cookie('square_oauth_user_id', user.sub, cookieOpts);

    res.json({ data: { authUrl } });
  });

  router.get('/square/status', async (req: Request, res: Response) => {
    const user = requireUser(req);
    const connection = await withRlsContext(user.org_id, user.isAdmin, (tx) =>
      integrationConnectionsQueries.getByOrgAndProvider(user.org_id, 'square', tx),
    );

    if (!connection) {
      res.json({ data: { connected: false } });
      return;
    }

    res.json({
      data: {
        connected: true,
        provider: 'square',
        merchantId: connection.providerTenantId,
        syncStatus: connection.syncStatus,
        lastSyncedAt: connection.lastSyncedAt,
        syncError: connection.syncError,
        connectedAt: connection.createdAt,
      },
    });
  });

  router.post('/square/sync', async (req: Request, res: Response) => {
    const user = requireUser(req);
    const connection = await withRlsContext(user.org_id, user.isAdmin, (tx) =>
      integrationConnectionsQueries.getByOrgAndProvider(user.org_id, 'square', tx),
    );

    if (!connection) {
      res.status(404).json({
        error: { code: 'NOT_CONNECTED', message: 'No Square connection found' },
      });
      return;
    }

    await enqueueSquareSyncJob(connection.id, 'manual');
    res.json({ data: { message: 'Sync started' } });
  });

  router.delete('/square', roleGuard('owner'), async (req: Request, res: Response) => {
    const user = requireUser(req);
    const connection = await withRlsContext(user.org_id, user.isAdmin, (tx) =>
      integrationConnectionsQueries.getByOrgAndProvider(user.org_id, 'square', tx),
    );

    if (!connection) {
      res.status(404).json({
        error: { code: 'NOT_CONNECTED', message: 'No Square connection found' },
      });
      return;
    }

    await squareOAuth.revokeToken(decrypt(connection.encryptedAccessToken));
    await removeSquareDailySync(user.org_id);
    await withRlsContext(user.org_id, user.isAdmin, (tx) =>
      integrationConnectionsQueries.deleteByOrgAndProvider(user.org_id, 'square', tx),
    );

    trackEvent(user.org_id, Number(user.sub), ANALYTICS_EVENTS.INTEGRATION_DISCONNECTED, {
      provider: 'square',
    });

    auditAuth(req, AUDIT_ACTIONS.INTEGRATION_DISCONNECTED, {
      targetType: 'integration',
      targetId: 'square',
    });

    logger.info({ orgId: user.org_id }, 'Square disconnected');
    res.json({ data: { message: 'Square disconnected' } });
  });
}
