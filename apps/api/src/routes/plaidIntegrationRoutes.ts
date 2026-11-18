import type { Request, Response, Router } from 'express';

import { ANALYTICS_EVENTS, AUDIT_ACTIONS } from 'shared/constants';

import { datasetsQueries, integrationConnectionsQueries } from '../db/queries/index.js';
import { logger } from '../lib/logger.js';
import { requireUser } from '../lib/requireUser.js';
import { withRlsContext } from '../lib/rls.js';
import { roleGuard } from '../middleware/roleGuard.js';
import { trackEvent } from '../services/analytics/trackEvent.js';
import { auditAuth } from '../services/audit/auditService.js';
import { encrypt } from '../services/integrations/encryption.js';
import { createLinkToken, exchangePublicToken } from '../services/integrations/plaid/api.js';
import { enqueueSyncJob } from '../services/integrations/plaid/worker.js';

const MAX_INSTITUTION_NAME = 120;

export function registerPlaidIntegrationRoutes(router: Router): void {
  // Plaid Link is client-side, so this replaces the /connect + redirect +
  // callback shape the other three connectors use. There is no provider
  // redirect and therefore no oauthState nonce: the exchange below arrives on
  // the caller's own authenticated session, which is what the CSRF round trip
  // was standing in for everywhere else.
  router.post('/plaid/link-token', roleGuard('owner'), async (req: Request, res: Response) => {
    const user = requireUser(req);

    const existing = await withRlsContext(user.org_id, user.isAdmin, (tx) =>
      integrationConnectionsQueries.getByOrgAndProvider(user.org_id, 'plaid', tx),
    );
    if (existing) {
      res.status(409).json({
        error: { code: 'ALREADY_CONNECTED', message: 'A bank account is already connected' },
      });
      return;
    }

    const { link_token, expiration } = await createLinkToken(user.org_id);
    res.json({ data: { linkToken: link_token, expiresAt: expiration } });
  });

  router.post('/plaid/exchange', roleGuard('owner'), async (req: Request, res: Response) => {
    const user = requireUser(req);
    const orgId = user.org_id;
    const publicToken = String(req.body?.publicToken ?? '');
    // Link's onSuccess metadata carries it. Taken from the client because the
    // alternative is two more Plaid calls (/item/get then /institutions/
    // get_by_id) for a display string, and a wrong one costs a dataset title
    // rather than any correctness.
    const institutionName = String(req.body?.institutionName ?? '')
      .trim()
      .slice(0, MAX_INSTITUTION_NAME);

    if (!publicToken) {
      res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: 'publicToken is required' },
      });
      return;
    }

    const { access_token, item_id } = await exchangePublicToken(publicToken);

    // Every write goes through the scoped client. The exchange runs on the
    // owner's own session, so unlike the redirect callbacks the other connectors
    // use there is a context to scope by, and the unscoped default client would
    // be rejected by RLS with 42501 rather than failing quietly.
    const connection = await withRlsContext(orgId, user.isAdmin, async (tx) => {
      const stored = await integrationConnectionsQueries.upsert(
        {
          orgId,
          provider: 'plaid',
          providerTenantId: item_id,
          encryptedAccessToken: encrypt(access_token),
          // Plaid has neither, which is what migration 0050 relaxed the columns
          // for.
          encryptedRefreshToken: null,
          accessTokenExpiresAt: null,
        },
        tx,
      );

      // Created here rather than on first sync because this is the only point
      // the institution name is known. runSync still has a find-or-create so a
      // deleted dataset does not break a sync; it just falls back to naming it
      // by item id.
      const existing = (await datasetsQueries.getDatasetsByOrg(orgId, tx)).find(
        (ds) => ds.sourceType === 'plaid',
      );
      if (!existing) {
        await datasetsQueries.createDataset(
          orgId,
          { name: `Bank, ${institutionName || item_id}`, sourceType: 'plaid' },
          tx,
        );
      }

      return stored;
    });

    await enqueueSyncJob(connection.id, 'manual');

    auditAuth(req, AUDIT_ACTIONS.INTEGRATION_CONNECTED, {
      targetType: 'integration',
      targetId: 'plaid',
    });
    trackEvent(orgId, Number(user.sub), ANALYTICS_EVENTS.INTEGRATION_CONNECTED, {
      provider: 'plaid',
    });
    logger.info({ orgId, connectionId: connection.id }, 'Plaid connected');

    res.status(201).json({ data: { connected: true, syncStatus: 'syncing' } });
  });

  router.post('/plaid/sync', roleGuard('owner'), async (req: Request, res: Response) => {
    const user = requireUser(req);

    const connection = await withRlsContext(user.org_id, user.isAdmin, (tx) =>
      integrationConnectionsQueries.getByOrgAndProvider(user.org_id, 'plaid', tx),
    );
    if (!connection) {
      res.status(404).json({
        error: { code: 'NOT_CONNECTED', message: 'No bank connection found' },
      });
      return;
    }

    await enqueueSyncJob(connection.id, 'manual');
    res.status(202).json({ data: { syncStatus: 'syncing' } });
  });

  router.delete('/plaid', roleGuard('owner'), async (req: Request, res: Response) => {
    const user = requireUser(req);
    const orgId = user.org_id;

    const connection = await withRlsContext(orgId, user.isAdmin, (tx) =>
      integrationConnectionsQueries.getByOrgAndProvider(orgId, 'plaid', tx),
    );
    if (!connection) {
      res.status(404).json({
        error: { code: 'NOT_CONNECTED', message: 'No bank connection found' },
      });
      return;
    }

    // No token to revoke at Plaid's end from here. /item/remove exists and is
    // worth adding, but it is a network call that can fail, and failing it must
    // not leave the owner unable to disconnect locally. Deliberate gap rather
    // than an oversight: the stored token is deleted either way.
    await withRlsContext(orgId, user.isAdmin, (tx) =>
      integrationConnectionsQueries.deleteByOrgAndProvider(orgId, 'plaid', tx),
    );

    auditAuth(req, AUDIT_ACTIONS.INTEGRATION_DISCONNECTED, {
      targetType: 'integration',
      targetId: 'plaid',
    });
    trackEvent(orgId, Number(user.sub), ANALYTICS_EVENTS.INTEGRATION_DISCONNECTED, {
      provider: 'plaid',
    });

    res.json({ data: { connected: false } });
  });
}
