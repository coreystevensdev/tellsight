import { Router } from 'express';
import type { Response, Request } from 'express';

import { ANALYTICS_EVENTS } from 'shared/constants';

import { env, isQbConfigured } from '../config.js';
import { logger } from '../lib/logger.js';
import { requireUser } from '../lib/requireUser.js';
import { roleGuard } from '../middleware/roleGuard.js';
import { integrationConnectionsQueries } from '../db/queries/index.js';
import { encrypt } from '../services/integrations/encryption.js';
import * as qbOAuth from '../services/integrations/quickbooks/oauth.js';
import { enqueueSyncJob } from '../services/integrations/worker.js';
import { registerDailySync, removeDailySync } from '../services/integrations/scheduler.js';
import { trackEvent } from '../services/analytics/trackEvent.js';
import { audit, auditAuth } from '../services/audit/auditService.js';
import { sessionCookieOptions } from '../lib/cookies.js';
import { AUDIT_ACTIONS } from 'shared/constants';

function qbGuard(_req: Request, res: Response, next: () => void) {
  if (!isQbConfigured(env)) {
    res.status(501).json({
      error: { code: 'INTEGRATION_NOT_CONFIGURED', message: 'QuickBooks integration is not configured' },
    });
    return;
  }
  next();
}

// Protected routes (require auth)
export const integrationsRouter = Router();
integrationsRouter.use(qbGuard);

integrationsRouter.post('/quickbooks/connect', async (req: Request, res: Response) => {
  const user = requireUser(req);
  const orgId = user.org_id;

  const existing = await integrationConnectionsQueries.getByOrgAndProvider(orgId, 'quickbooks');
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
  const connection = await integrationConnectionsQueries.getByOrgAndProvider(user.org_id, 'quickbooks');

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
  const connection = await integrationConnectionsQueries.getByOrgAndProvider(user.org_id, 'quickbooks');

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

integrationsRouter.delete('/quickbooks', roleGuard('owner'), async (req: Request, res: Response) => {
  const user = requireUser(req);
  const connection = await integrationConnectionsQueries.getByOrgAndProvider(user.org_id, 'quickbooks');

  if (!connection) {
    res.status(404).json({
      error: { code: 'NOT_CONNECTED', message: 'No QuickBooks connection found' },
    });
    return;
  }

  await qbOAuth.revokeToken(connection.encryptedRefreshToken);
  await removeDailySync(user.org_id);
  await integrationConnectionsQueries.deleteByOrgAndProvider(user.org_id, 'quickbooks');

  trackEvent(user.org_id, Number(user.sub), ANALYTICS_EVENTS.INTEGRATION_DISCONNECTED, {
    provider: 'quickbooks',
  });

  auditAuth(req, AUDIT_ACTIONS.INTEGRATION_DISCONNECTED, {
    targetType: 'integration',
    targetId: 'quickbooks',
  });

  logger.info({ orgId: user.org_id }, 'QuickBooks disconnected');
  res.json({ data: { message: 'QuickBooks disconnected' } });
});

// Public callback route (Intuit redirects browser here — no auth cookies)
export const integrationsCallbackRouter = Router();
integrationsCallbackRouter.use(qbGuard);

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
    // We encode orgId in a signed cookie set during /connect, or — simpler for now —
    // extract it from the state param. For MVP, we use a temp cookie set at /connect time.
    const orgIdCookie = req.cookies?.qb_oauth_org_id;
    const userId = req.cookies?.qb_oauth_user_id;

    if (!orgIdCookie || !userId) {
      logger.error({}, 'QB OAuth callback missing org/user identity cookies');
      res.redirect(`${dashboardUrl}?qb=error`);
      return;
    }

    const orgId = Number(orgIdCookie);

    const connection = await integrationConnectionsQueries.upsert({
      orgId,
      provider: 'quickbooks',
      providerTenantId: realmId,
      encryptedRefreshToken,
      encryptedAccessToken,
      accessTokenExpiresAt,
      scope: 'com.intuit.quickbooks.accounting',
    });

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
