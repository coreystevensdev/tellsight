import { Router } from 'express';
import type { Response, Request } from 'express';

import { ANALYTICS_EVENTS } from 'shared/constants';

import { env, isQbConfigured, isShopifyConfigured, isSquareConfigured } from '../config.js';
import { logger } from '../lib/logger.js';
import { requireUser } from '../lib/requireUser.js';
import { roleGuard } from '../middleware/roleGuard.js';
import { ValidationError } from '../lib/appError.js';
import { integrationConnectionsQueries } from '../db/queries/index.js';
import { withRlsContext } from '../lib/rls.js';
import { decrypt } from '../services/integrations/encryption.js';
import * as qbOAuth from '../services/integrations/quickbooks/oauth.js';
import { enqueueSyncJob } from '../services/integrations/worker.js';
import { removeDailySync } from '../services/integrations/scheduler.js';
import * as shopifyOAuth from '../services/integrations/shopify/oauth.js';
import { enqueueSyncJob as enqueueShopifySyncJob } from '../services/integrations/shopify/worker.js';
import { removeDailySync as removeShopifyDailySync } from '../services/integrations/shopify/scheduler.js';
import * as squareOAuth from '../services/integrations/square/oauth.js';
import { enqueueSyncJob as enqueueSquareSyncJob } from '../services/integrations/square/worker.js';
import { removeDailySync as removeSquareDailySync } from '../services/integrations/square/scheduler.js';
import { trackEvent } from '../services/analytics/trackEvent.js';
import { auditAuth } from '../services/audit/auditService.js';
import { sessionCookieOptions } from '../lib/cookies.js';
import { AUDIT_ACTIONS } from 'shared/constants';
import { registerIntegrationCallbacks } from './integrationCallbacks.js';

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

// Shopify's authorize URL is per-shop (https://{shop}.myshopify.com/admin/oauth/...),
// unlike Intuit's, so /connect needs the shop domain up front instead of
// discovering it during the provider's own login flow.
integrationsRouter.post('/shopify/connect', async (req: Request, res: Response) => {
  const user = requireUser(req);
  const orgId = user.org_id;
  const shop = (req.body as { shop?: string })?.shop?.trim().toLowerCase();

  if (!shop || !shopifyOAuth.isValidShopDomain(shop)) {
    throw new ValidationError(
      'A valid Shopify store domain is required (e.g. your-store.myshopify.com)',
    );
  }

  const existing = await withRlsContext(orgId, user.isAdmin, (tx) =>
    integrationConnectionsQueries.getByOrgAndProvider(orgId, 'shopify', tx),
  );
  if (existing) {
    res.status(409).json({
      error: { code: 'ALREADY_CONNECTED', message: 'Shopify is already connected' },
    });
    return;
  }

  const { authUrl, state } = shopifyOAuth.generateAuthUrl(shop);

  const cookieOpts = sessionCookieOptions(10 * 60);

  res.cookie('shopify_oauth_state', state, cookieOpts);
  res.cookie('shopify_oauth_org_id', String(orgId), cookieOpts);
  res.cookie('shopify_oauth_user_id', user.sub, cookieOpts);

  res.json({ data: { authUrl } });
});

integrationsRouter.get('/shopify/status', async (req: Request, res: Response) => {
  const user = requireUser(req);
  const connection = await withRlsContext(user.org_id, user.isAdmin, (tx) =>
    integrationConnectionsQueries.getByOrgAndProvider(user.org_id, 'shopify', tx),
  );

  if (!connection) {
    res.json({ data: { connected: false } });
    return;
  }

  res.json({
    data: {
      connected: true,
      provider: 'shopify',
      shopDomain: connection.providerTenantId,
      syncStatus: connection.syncStatus,
      lastSyncedAt: connection.lastSyncedAt,
      syncError: connection.syncError,
      connectedAt: connection.createdAt,
    },
  });
});

integrationsRouter.post('/shopify/sync', async (req: Request, res: Response) => {
  const user = requireUser(req);
  const connection = await withRlsContext(user.org_id, user.isAdmin, (tx) =>
    integrationConnectionsQueries.getByOrgAndProvider(user.org_id, 'shopify', tx),
  );

  if (!connection) {
    res.status(404).json({
      error: { code: 'NOT_CONNECTED', message: 'No Shopify connection found' },
    });
    return;
  }

  if (connection.syncStatus === 'syncing') {
    res.status(409).json({
      error: { code: 'SYNC_IN_PROGRESS', message: 'A sync is already in progress' },
    });
    return;
  }

  await enqueueShopifySyncJob(connection.id, 'manual');
  res.json({ data: { message: 'Sync started' } });
});

integrationsRouter.delete('/shopify', roleGuard('owner'), async (req: Request, res: Response) => {
  const user = requireUser(req);
  const connection = await withRlsContext(user.org_id, user.isAdmin, (tx) =>
    integrationConnectionsQueries.getByOrgAndProvider(user.org_id, 'shopify', tx),
  );

  if (!connection) {
    res.status(404).json({
      error: { code: 'NOT_CONNECTED', message: 'No Shopify connection found' },
    });
    return;
  }

  await shopifyOAuth.revokeToken(
    connection.providerTenantId,
    decrypt(connection.encryptedAccessToken),
  );
  await removeShopifyDailySync(user.org_id);
  await withRlsContext(user.org_id, user.isAdmin, (tx) =>
    integrationConnectionsQueries.deleteByOrgAndProvider(user.org_id, 'shopify', tx),
  );

  trackEvent(user.org_id, Number(user.sub), ANALYTICS_EVENTS.INTEGRATION_DISCONNECTED, {
    provider: 'shopify',
  });

  auditAuth(req, AUDIT_ACTIONS.INTEGRATION_DISCONNECTED, {
    targetType: 'integration',
    targetId: 'shopify',
  });

  logger.info({ orgId: user.org_id }, 'Shopify disconnected');
  res.json({ data: { message: 'Shopify disconnected' } });
});

// Unlike Shopify, a Square authorize URL is the same for every seller, so
// /connect needs nothing from the caller: which merchant is connecting only
// becomes known when the callback returns a merchant_id.
integrationsRouter.post('/square/connect', async (req: Request, res: Response) => {
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

integrationsRouter.get('/square/status', async (req: Request, res: Response) => {
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

integrationsRouter.post('/square/sync', async (req: Request, res: Response) => {
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

integrationsRouter.delete('/square', roleGuard('owner'), async (req: Request, res: Response) => {
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

// Public callback routes (providers redirect the browser here, no auth cookies)
export const integrationsCallbackRouter = Router();
integrationsCallbackRouter.use('/quickbooks', qbGuard);
integrationsCallbackRouter.use('/shopify', shopifyGuard);
integrationsCallbackRouter.use('/square', squareGuard);
registerIntegrationCallbacks(integrationsCallbackRouter);
