import type { Request, Response, Router } from 'express';

import { ANALYTICS_EVENTS, AUDIT_ACTIONS } from 'shared/constants';

import { integrationConnectionsQueries } from '../db/queries/index.js';
import { ValidationError } from '../lib/appError.js';
import { sessionCookieOptions } from '../lib/cookies.js';
import { logger } from '../lib/logger.js';
import { requireUser } from '../lib/requireUser.js';
import { withRlsContext } from '../lib/rls.js';
import { roleGuard } from '../middleware/roleGuard.js';
import { trackEvent } from '../services/analytics/trackEvent.js';
import { auditAuth } from '../services/audit/auditService.js';
import { decrypt } from '../services/integrations/encryption.js';
import * as shopifyOAuth from '../services/integrations/shopify/oauth.js';
import { removeDailySync as removeShopifyDailySync } from '../services/integrations/shopify/scheduler.js';
import { enqueueSyncJob as enqueueShopifySyncJob } from '../services/integrations/shopify/worker.js';

export function registerShopifyIntegrationRoutes(router: Router): void {
  // Shopify's authorize URL is per-shop (https://{shop}.myshopify.com/admin/oauth/...),
  // unlike Intuit's, so /connect needs the shop domain up front instead of
  // discovering it during the provider's own login flow.
  router.post('/shopify/connect', async (req: Request, res: Response) => {
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

  router.get('/shopify/status', async (req: Request, res: Response) => {
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

  router.post('/shopify/sync', async (req: Request, res: Response) => {
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

  router.delete('/shopify', roleGuard('owner'), async (req: Request, res: Response) => {
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
}
