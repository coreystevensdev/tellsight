import { Router } from 'express';
import type { Response, Request } from 'express';

import { ANALYTICS_EVENTS } from 'shared/constants';

import { env, isQbConfigured, isShopifyConfigured, isSquareConfigured } from '../config.js';
import { logger } from '../lib/logger.js';
import { requireUser } from '../lib/requireUser.js';
import { roleGuard } from '../middleware/roleGuard.js';
import { integrationConnectionsQueries } from '../db/queries/index.js';
import { withRlsContext } from '../lib/rls.js';
import * as qbOAuth from '../services/integrations/quickbooks/oauth.js';
import { enqueueSyncJob } from '../services/integrations/worker.js';
import { removeDailySync } from '../services/integrations/scheduler.js';
import { trackEvent } from '../services/analytics/trackEvent.js';
import { auditAuth } from '../services/audit/auditService.js';
import { sessionCookieOptions } from '../lib/cookies.js';
import { AUDIT_ACTIONS } from 'shared/constants';
import { registerIntegrationCallbacks } from './integrationCallbacks.js';
import { registerSquareIntegrationRoutes } from './squareIntegrationRoutes.js';
import { registerShopifyIntegrationRoutes } from './shopifyIntegrationRoutes.js';

function qbGuard(_req: Request, res: Response, next: () => void) {
  if (!isQbConfigured(env)) {
    res.status(501).json({
      error: {
        code: 'INTEGRATION_NOT_CONFIGURED',
        message: 'QuickBooks integration is not configured',
      },
    });
    return;
  }
  next();
}

function shopifyGuard(_req: Request, res: Response, next: () => void) {
  if (!isShopifyConfigured(env)) {
    res.status(501).json({
      error: {
        code: 'INTEGRATION_NOT_CONFIGURED',
        message: 'Shopify integration is not configured',
      },
    });
    return;
  }
  next();
}

function squareGuard(_req: Request, res: Response, next: () => void) {
  if (!isSquareConfigured(env)) {
    res.status(501).json({
      error: {
        code: 'INTEGRATION_NOT_CONFIGURED',
        message: 'Square integration is not configured',
      },
    });
    return;
  }
  next();
}

// Protected routes (require auth). Guards are scoped per prefix, not
// blanket-applied to the router, /quickbooks/* and /shopify/* are gated
// independently so one provider being unconfigured doesn't 501 the other.
export const integrationsRouter = Router();
integrationsRouter.use('/quickbooks', qbGuard);
integrationsRouter.use('/shopify', shopifyGuard);
integrationsRouter.use('/square', squareGuard);

integrationsRouter.post('/quickbooks/connect', async (req: Request, res: Response) => {
  const user = requireUser(req);
  const orgId = user.org_id;

  const existing = await withRlsContext(orgId, user.isAdmin, (tx) =>
    integrationConnectionsQueries.getByOrgAndProvider(orgId, 'quickbooks', tx),
  );
  if (existing) {
    res.status(409).json({
      error: { code: 'ALREADY_CONNECTED', message: 'QuickBooks is already connected' },
    });
    return;
  }

  const { authUrl, state } = qbOAuth.generateAuthUrl();

  const cookieOpts = sessionCookieOptions(10 * 60);

  res.cookie('qb_oauth_state', state, cookieOpts);
  res.cookie('qb_oauth_org_id', String(orgId), cookieOpts);
  res.cookie('qb_oauth_user_id', user.sub, cookieOpts);

  res.json({ data: { authUrl } });
});

integrationsRouter.get('/quickbooks/status', async (req: Request, res: Response) => {
  const user = requireUser(req);
  const connection = await withRlsContext(user.org_id, user.isAdmin, (tx) =>
    integrationConnectionsQueries.getByOrgAndProvider(user.org_id, 'quickbooks', tx),
  );

  if (!connection) {
    res.json({ data: { connected: false } });
    return;
  }

  res.json({
    data: {
      connected: true,
      provider: 'quickbooks',
      companyName: connection.providerTenantId,
      syncStatus: connection.syncStatus,
      lastSyncedAt: connection.lastSyncedAt,
      syncError: connection.syncError,
      connectedAt: connection.createdAt,
    },
  });
});

integrationsRouter.post('/quickbooks/sync', async (req: Request, res: Response) => {
  const user = requireUser(req);
  const connection = await withRlsContext(user.org_id, user.isAdmin, (tx) =>
    integrationConnectionsQueries.getByOrgAndProvider(user.org_id, 'quickbooks', tx),
  );

  if (!connection) {
    res.status(404).json({
      error: { code: 'NOT_CONNECTED', message: 'No QuickBooks connection found' },
    });
    return;
  }

  if (connection.syncStatus === 'syncing') {
    res.status(409).json({
      error: { code: 'SYNC_IN_PROGRESS', message: 'A sync is already in progress' },
    });
    return;
  }

  await enqueueSyncJob(connection.id, 'manual');
  res.json({ data: { message: 'Sync started' } });
});

integrationsRouter.delete(
  '/quickbooks',
  roleGuard('owner'),
  async (req: Request, res: Response) => {
    const user = requireUser(req);
    const connection = await withRlsContext(user.org_id, user.isAdmin, (tx) =>
      integrationConnectionsQueries.getByOrgAndProvider(user.org_id, 'quickbooks', tx),
    );

    if (!connection) {
      res.status(404).json({
        error: { code: 'NOT_CONNECTED', message: 'No QuickBooks connection found' },
      });
      return;
    }

    await qbOAuth.revokeToken(connection.encryptedRefreshToken);
    await removeDailySync(user.org_id);
    await withRlsContext(user.org_id, user.isAdmin, (tx) =>
      integrationConnectionsQueries.deleteByOrgAndProvider(user.org_id, 'quickbooks', tx),
    );

    trackEvent(user.org_id, Number(user.sub), ANALYTICS_EVENTS.INTEGRATION_DISCONNECTED, {
      provider: 'quickbooks',
    });

    auditAuth(req, AUDIT_ACTIONS.INTEGRATION_DISCONNECTED, {
      targetType: 'integration',
      targetId: 'quickbooks',
    });

    logger.info({ orgId: user.org_id }, 'QuickBooks disconnected');
    res.json({ data: { message: 'QuickBooks disconnected' } });
  },
);

registerShopifyIntegrationRoutes(integrationsRouter);

registerSquareIntegrationRoutes(integrationsRouter);

// Public callback routes (providers redirect the browser here, no auth cookies)
export const integrationsCallbackRouter = Router();
integrationsCallbackRouter.use('/quickbooks', qbGuard);
integrationsCallbackRouter.use('/shopify', shopifyGuard);
integrationsCallbackRouter.use('/square', squareGuard);
registerIntegrationCallbacks(integrationsCallbackRouter);
