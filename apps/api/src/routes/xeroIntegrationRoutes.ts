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
import {
  newOAuthNonce,
  oauthNonceCookie,
  putOAuthState,
} from '../services/integrations/oauthState.js';
import { requireRefreshToken } from '../services/integrations/tokenRotation.js';
import * as xeroOAuth from '../services/integrations/xero/oauth.js';
import { removeDailySync } from '../services/integrations/xero/scheduler.js';
import { enqueueSyncJob } from '../services/integrations/xero/worker.js';

export function registerXeroIntegrationRoutes(router: Router): void {
  router.post('/xero/connect', async (req: Request, res: Response) => {
    const user = requireUser(req);
    const orgId = user.org_id;

    const existing = await withRlsContext(orgId, user.isAdmin, (tx) =>
      integrationConnectionsQueries.getByOrgAndProvider(orgId, 'xero', tx),
    );
    if (existing) {
      res.status(409).json({
        error: { code: 'ALREADY_CONNECTED', message: 'Xero is already connected' },
      });
      return;
    }

    const { authUrl, state } = xeroOAuth.generateAuthUrl();
    const nonce = newOAuthNonce();
    await putOAuthState('xero', state, {
      orgId,
      userId: Number(user.sub),
      nonce,
    });
    // Binds the flow to this browser. Carries no identity, so tampering with it
    // can only fail the callback.
    res.cookie(oauthNonceCookie('xero'), nonce, sessionCookieOptions(10 * 60));

    res.json({ data: { authUrl } });
  });

  router.get('/xero/status', async (req: Request, res: Response) => {
    const user = requireUser(req);
    const connection = await withRlsContext(user.org_id, user.isAdmin, (tx) =>
      integrationConnectionsQueries.getByOrgAndProvider(user.org_id, 'xero', tx),
    );

    if (!connection) {
      res.json({ data: { connected: false } });
      return;
    }

    res.json({
      data: {
        connected: true,
        provider: 'xero',
        companyName: connection.providerTenantId,
        syncStatus: connection.syncStatus,
        lastSyncedAt: connection.lastSyncedAt,
        syncError: connection.syncError,
        connectedAt: connection.createdAt,
      },
    });
  });

  router.post('/xero/sync', async (req: Request, res: Response) => {
    const user = requireUser(req);
    const connection = await withRlsContext(user.org_id, user.isAdmin, (tx) =>
      integrationConnectionsQueries.getByOrgAndProvider(user.org_id, 'xero', tx),
    );

    if (!connection) {
      res.status(404).json({
        error: { code: 'NOT_CONNECTED', message: 'No Xero connection found' },
      });
      return;
    }

    // Also the thing that keeps two refreshes off one connection: Xero destroys
    // the previous refresh token on rotation, so a manual sync starting
    // alongside a scheduled one is the race tokenRotation.ts has to settle
    // (DW-283). Refusing here removes the common way to reach it.
    if (connection.syncStatus === 'syncing') {
      res.status(409).json({
        error: { code: 'SYNC_IN_PROGRESS', message: 'A sync is already in progress' },
      });
      return;
    }

    await enqueueSyncJob(connection.id, 'manual');
    res.json({ data: { message: 'Sync started' } });
  });

  router.delete('/xero', roleGuard('owner'), async (req: Request, res: Response) => {
    const user = requireUser(req);
    const connection = await withRlsContext(user.org_id, user.isAdmin, (tx) =>
      integrationConnectionsQueries.getByOrgAndProvider(user.org_id, 'xero', tx),
    );

    if (!connection) {
      res.status(404).json({
        error: { code: 'NOT_CONNECTED', message: 'No Xero connection found' },
      });
      return;
    }

    await xeroOAuth.revokeToken(requireRefreshToken(connection));
    await removeDailySync(user.org_id);
    await withRlsContext(user.org_id, user.isAdmin, (tx) =>
      integrationConnectionsQueries.deleteByOrgAndProvider(user.org_id, 'xero', tx),
    );

    trackEvent(user.org_id, Number(user.sub), ANALYTICS_EVENTS.INTEGRATION_DISCONNECTED, {
      provider: 'xero',
    });

    auditAuth(req, AUDIT_ACTIONS.INTEGRATION_DISCONNECTED, {
      targetType: 'integration',
      targetId: 'xero',
    });

    logger.info({ orgId: user.org_id }, 'Xero disconnected');
    res.json({ data: { message: 'Xero disconnected' } });
  });
}
