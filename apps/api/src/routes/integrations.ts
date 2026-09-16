import { Router } from 'express';
import type { Response, Request } from 'express';

import { ANALYTICS_EVENTS } from 'shared/constants';

import { env, isQbConfigured, isShopifyConfigured, isSquareConfigured } from '../config.js';
import { logger } from '../lib/logger.js';
import { requireUser } from '../lib/requireUser.js';
import { roleGuard } from '../middleware/roleGuard.js';
import { ValidationError } from '../lib/appError.js';
import { integrationConnectionsQueries } from '../db/queries/index.js';
import { dbAdmin } from '../lib/db.js';
import { withRlsContext } from '../lib/rls.js';
import { encrypt, decrypt } from '../services/integrations/encryption.js';
import * as qbOAuth from '../services/integrations/quickbooks/oauth.js';
import { enqueueSyncJob } from '../services/integrations/worker.js';
import { registerDailySync, removeDailySync } from '../services/integrations/scheduler.js';
import * as shopifyOAuth from '../services/integrations/shopify/oauth.js';
import { enqueueSyncJob as enqueueShopifySyncJob } from '../services/integrations/shopify/worker.js';
import {
  registerDailySync as registerShopifyDailySync,
  removeDailySync as removeShopifyDailySync,
} from '../services/integrations/shopify/scheduler.js';
import * as squareOAuth from '../services/integrations/square/oauth.js';
import { enqueueSyncJob as enqueueSquareSyncJob } from '../services/integrations/square/worker.js';
import {
  registerDailySync as registerSquareDailySync,
  removeDailySync as removeSquareDailySync,
} from '../services/integrations/square/scheduler.js';
import { trackEvent } from '../services/analytics/trackEvent.js';
import { audit, auditAuth } from '../services/audit/auditService.js';
import { sessionCookieOptions } from '../lib/cookies.js';
import { AUDIT_ACTIONS } from 'shared/constants';

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

// Callback routes are public: the provider redirects the browser here with no
// session, so RLS has no app.current_org_id to match and every write is refused.
// The org comes from the signed cookie set during /connect, which is why these
// pass dbAdmin with an explicit orgId, the same shape alertMute uses for its
// token-authenticated write.
integrationsCallbackRouter.get('/quickbooks/callback', async (req: Request, res: Response) => {
  const { code, realmId, state, error } = req.query as Record<string, string | undefined>;
  const dashboardUrl = `${env.APP_URL}/dashboard`;

  if (error) {
    logger.warn({ error }, 'QuickBooks OAuth denied by user');
    res.redirect(`${dashboardUrl}?qb=denied`);
    return;
  }

  const storedState = req.cookies?.qb_oauth_state;
  if (!storedState || storedState !== state) {
    logger.warn({ storedState: !!storedState, state: !!state }, 'QB OAuth state mismatch');
    res.redirect(`${dashboardUrl}?qb=error`);
    return;
  }

  res.clearCookie('qb_oauth_state', { path: '/' });

  if (!code || !realmId) {
    logger.warn({}, 'QB OAuth callback missing code or realmId');
    res.redirect(`${dashboardUrl}?qb=error`);
    return;
  }

  try {
    const tokens = await qbOAuth.exchangeCode(code, realmId);

    const encryptedAccessToken = encrypt(tokens.accessToken);
    const encryptedRefreshToken = encrypt(tokens.refreshToken);
    const accessTokenExpiresAt = new Date(Date.now() + tokens.expiresIn * 1000);

    // The callback doesn't have auth context (browser redirect from Intuit).
    // We encode orgId in a signed cookie set during /connect, or, simpler for now
    // extract it from the state param. For MVP, we use a temp cookie set at /connect time.
    const orgIdCookie = req.cookies?.qb_oauth_org_id;
    const userId = req.cookies?.qb_oauth_user_id;

    if (!orgIdCookie || !userId) {
      logger.error({}, 'QB OAuth callback missing org/user identity cookies');
      res.redirect(`${dashboardUrl}?qb=error`);
      return;
    }

    const orgId = Number(orgIdCookie);

    const connection = await integrationConnectionsQueries.upsert(
      {
        orgId,
        provider: 'quickbooks',
        providerTenantId: realmId,
        encryptedRefreshToken,
        encryptedAccessToken,
        accessTokenExpiresAt,
        scope: 'com.intuit.quickbooks.accounting',
      },
      dbAdmin,
    );

    res.clearCookie('qb_oauth_org_id', { path: '/' });
    res.clearCookie('qb_oauth_user_id', { path: '/' });

    await enqueueSyncJob(connection.id, 'initial');
    await registerDailySync(orgId, connection.id);

    trackEvent(orgId, Number(userId), ANALYTICS_EVENTS.INTEGRATION_CONNECTED, {
      provider: 'quickbooks',
      realmId,
    });

    audit(req, {
      orgId,
      userId: Number(userId),
      action: AUDIT_ACTIONS.INTEGRATION_CONNECTED,
      targetType: 'integration',
      targetId: 'quickbooks',
      metadata: { realmId },
    });

    logger.info({ orgId, realmId }, 'QuickBooks connected');
    res.redirect(`${dashboardUrl}?qb=connected`);
  } catch (err) {
    logger.error({ err }, 'QB OAuth callback failed');
    res.redirect(`${dashboardUrl}?qb=error`);
  }
});

integrationsCallbackRouter.get('/shopify/callback', async (req: Request, res: Response) => {
  const query = req.query as Record<string, string | undefined>;
  const { code, shop, state } = query;
  const dashboardUrl = `${env.APP_URL}/dashboard`;

  if (!shop || !shopifyOAuth.isValidShopDomain(shop)) {
    logger.warn({ shop }, 'Shopify OAuth callback had an invalid shop domain');
    res.redirect(`${dashboardUrl}?shopify=error`);
    return;
  }

  // HMAC proves the redirect actually came from Shopify; state proves it's
  // this browser's own flow. Independent checks, both required.
  if (!shopifyOAuth.verifyHmac(query)) {
    logger.warn({ shop }, 'Shopify OAuth callback failed HMAC verification');
    res.redirect(`${dashboardUrl}?shopify=error`);
    return;
  }

  const storedState = req.cookies?.shopify_oauth_state;
  if (!storedState || storedState !== state) {
    logger.warn({ storedState: !!storedState, state: !!state }, 'Shopify OAuth state mismatch');
    res.redirect(`${dashboardUrl}?shopify=error`);
    return;
  }

  res.clearCookie('shopify_oauth_state', { path: '/' });

  if (!code) {
    logger.warn({}, 'Shopify OAuth callback missing code');
    res.redirect(`${dashboardUrl}?shopify=error`);
    return;
  }

  try {
    const tokens = await shopifyOAuth.exchangeCode(shop, code);
    const encryptedAccessToken = encrypt(tokens.accessToken);

    const orgIdCookie = req.cookies?.shopify_oauth_org_id;
    const userId = req.cookies?.shopify_oauth_user_id;

    if (!orgIdCookie || !userId) {
      logger.error({}, 'Shopify OAuth callback missing org/user identity cookies');
      res.redirect(`${dashboardUrl}?shopify=error`);
      return;
    }

    const orgId = Number(orgIdCookie);

    // A standard offline Shopify access token doesn't expire and has no
    // refresh token (see oauth.ts), so both encrypted-token columns hold the
    // same value and the expiry is a far-future sentinel rather than a real
    // deadline the way QuickBooks' is.
    const connection = await integrationConnectionsQueries.upsert(
      {
        orgId,
        provider: 'shopify',
        providerTenantId: shop,
        encryptedRefreshToken: encryptedAccessToken,
        encryptedAccessToken,
        accessTokenExpiresAt: new Date('9999-12-31T23:59:59Z'),
        scope: 'read_orders,read_products,read_inventory',
      },
      dbAdmin,
    );

    res.clearCookie('shopify_oauth_org_id', { path: '/' });
    res.clearCookie('shopify_oauth_user_id', { path: '/' });

    await enqueueShopifySyncJob(connection.id, 'initial');
    await registerShopifyDailySync(orgId, connection.id);

    trackEvent(orgId, Number(userId), ANALYTICS_EVENTS.INTEGRATION_CONNECTED, {
      provider: 'shopify',
      shop,
    });

    audit(req, {
      orgId,
      userId: Number(userId),
      action: AUDIT_ACTIONS.INTEGRATION_CONNECTED,
      targetType: 'integration',
      targetId: 'shopify',
      metadata: { shop },
    });

    logger.info({ orgId, shop }, 'Shopify connected');
    res.redirect(`${dashboardUrl}?shopify=connected`);
  } catch (err) {
    logger.error({ err }, 'Shopify OAuth callback failed');
    res.redirect(`${dashboardUrl}?shopify=error`);
  }
});

// Square signs nothing on the callback, so unlike Shopify there is no HMAC to
// check and the state cookie is the only thing standing between this and a
// forged redirect.
integrationsCallbackRouter.get('/square/callback', async (req: Request, res: Response) => {
  const { code, state, error } = req.query as Record<string, string | undefined>;
  const dashboardUrl = `${env.APP_URL}/dashboard`;

  if (error) {
    logger.warn({ error }, 'Square OAuth denied by user');
    res.redirect(`${dashboardUrl}?square=denied`);
    return;
  }

  const storedState = req.cookies?.square_oauth_state;
  if (!storedState || storedState !== state) {
    logger.warn({ storedState: !!storedState, state: !!state }, 'Square OAuth state mismatch');
    res.redirect(`${dashboardUrl}?square=error`);
    return;
  }

  res.clearCookie('square_oauth_state', { path: '/' });

  if (!code) {
    logger.warn({}, 'Square OAuth callback missing code');
    res.redirect(`${dashboardUrl}?square=error`);
    return;
  }

  try {
    const orgIdCookie = req.cookies?.square_oauth_org_id;
    const userId = req.cookies?.square_oauth_user_id;

    if (!orgIdCookie || !userId) {
      logger.error({}, 'Square OAuth callback missing org/user identity cookies');
      res.redirect(`${dashboardUrl}?square=error`);
      return;
    }

    const tokens = await squareOAuth.exchangeCode(code);
    const orgId = Number(orgIdCookie);

    // Square hands back a real refresh token and a real deadline, so this row
    // needs none of the sentinel values the Shopify one does.
    const connection = await integrationConnectionsQueries.upsert(
      {
        orgId,
        provider: 'square',
        providerTenantId: tokens.merchantId,
        encryptedRefreshToken: encrypt(tokens.refreshToken),
        encryptedAccessToken: encrypt(tokens.accessToken),
        accessTokenExpiresAt: tokens.expiresAt,
        scope: tokens.scope,
      },
      dbAdmin,
    );

    res.clearCookie('square_oauth_org_id', { path: '/' });
    res.clearCookie('square_oauth_user_id', { path: '/' });

    await enqueueSquareSyncJob(connection.id, 'initial');
    await registerSquareDailySync(orgId, connection.id);

    trackEvent(orgId, Number(userId), ANALYTICS_EVENTS.INTEGRATION_CONNECTED, {
      provider: 'square',
      merchantId: tokens.merchantId,
    });

    audit(req, {
      orgId,
      userId: Number(userId),
      action: AUDIT_ACTIONS.INTEGRATION_CONNECTED,
      targetType: 'integration',
      targetId: 'square',
    });

    logger.info({ orgId, merchantId: tokens.merchantId }, 'Square connected');
    res.redirect(`${dashboardUrl}?square=connected`);
  } catch (err) {
    logger.error({ err }, 'Square OAuth callback failed');
    res.redirect(`${dashboardUrl}?square=error`);
  }
});
