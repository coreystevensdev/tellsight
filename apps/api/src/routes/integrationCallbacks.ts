import type { Request, Response, Router } from 'express';

import { ANALYTICS_EVENTS, AUDIT_ACTIONS } from 'shared/constants';

import { env } from '../config.js';
import { integrationConnectionsQueries } from '../db/queries/index.js';
import { clearCookie } from '../lib/cookies.js';
import { dbAdmin } from '../lib/db.js';
import { logger } from '../lib/logger.js';
import { trackEvent } from '../services/analytics/trackEvent.js';
import { audit } from '../services/audit/auditService.js';
import { encrypt } from '../services/integrations/encryption.js';
import {
  nonceMatches,
  oauthNonceCookie,
  takeOAuthState,
} from '../services/integrations/oauthState.js';
import * as qbOAuth from '../services/integrations/quickbooks/oauth.js';
import { registerDailySync } from '../services/integrations/scheduler.js';
import { enqueueSyncJob } from '../services/integrations/worker.js';
import * as shopifyOAuth from '../services/integrations/shopify/oauth.js';
import { registerDailySync as registerShopifyDailySync } from '../services/integrations/shopify/scheduler.js';
import { enqueueSyncJob as enqueueShopifySyncJob } from '../services/integrations/shopify/worker.js';
import * as squareOAuth from '../services/integrations/square/oauth.js';
import { registerDailySync as registerSquareDailySync } from '../services/integrations/square/scheduler.js';
import { enqueueSyncJob as enqueueSquareSyncJob } from '../services/integrations/square/worker.js';

// Callback routes are public: the provider redirects the browser here with no
// session, so RLS has no app.current_org_id to match and every write is refused,
// which is why these pass dbAdmin with an explicit orgId.
//
// That orgId comes from takeOAuthState, keyed by the state the provider echoes
// back. It used to come from a cookie the browser could edit, and the comment
// here claimed that cookie was signed when nothing signed it, so the write could
// be aimed at any org id. Never read identity off req.cookies in these handlers.
//
// The nonce cookie is the one thing still read from the browser, and it is not
// identity: it proves the browser finishing this flow is the one that started
// it. Without that check the binding alone lets an attacker start a flow against
// their own org and walk a victim through consent, landing the victim's books in
// the attacker's org.
export function registerIntegrationCallbacks(router: Router): void {
  router.get('/quickbooks/callback', async (req: Request, res: Response) => {
    const { code, realmId, state, error } = req.query as Record<string, string | undefined>;
    const dashboardUrl = `${env.APP_URL}/dashboard`;

    if (error) {
      logger.warn({ error }, 'QuickBooks OAuth denied by user');
      res.redirect(`${dashboardUrl}?qb=denied`);
      return;
    }

    // The binding is the authorization check. state was minted by /connect against an
    // authenticated session, so the org it resolves to is the org that started the flow.
    // Reads are single-use, which also makes a replayed callback fail here.
    const flow = await takeOAuthState('quickbooks', state);
    if (!flow) {
      logger.warn({ hasState: !!state }, 'QB OAuth state unknown, expired or already used');
      res.redirect(`${dashboardUrl}?qb=error`);
      return;
    }

    const nonceCookie = req.cookies?.[oauthNonceCookie('quickbooks')] as string | undefined;
    clearCookie(res, oauthNonceCookie('quickbooks'));
    if (!nonceMatches(nonceCookie, flow.nonce)) {
      logger.warn({ hasNonce: !!nonceCookie }, 'quickbooks OAuth nonce missing or mismatched');
      res.redirect(`${dashboardUrl}?qb=error`);
      return;
    }

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

      const { orgId, userId } = flow;

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

      await enqueueSyncJob(connection.id, 'initial');
      await registerDailySync(orgId, connection.id);

      trackEvent(orgId, userId, ANALYTICS_EVENTS.INTEGRATION_CONNECTED, {
        provider: 'quickbooks',
        realmId,
      });

      audit(req, {
        orgId,
        userId,
        action: AUDIT_ACTIONS.INTEGRATION_CONNECTED,
        targetType: 'integration',
        targetId: 'quickbooks',
        metadata: { realmId },
      });

      logger.info({ orgId, realmId }, 'QuickBooks connected');
      res.redirect(`${dashboardUrl}?qb=connected`);
    } catch (error) {
      logger.error({ err: error }, 'QB OAuth callback failed');
      res.redirect(`${dashboardUrl}?qb=error`);
    }
  });

  router.get('/shopify/callback', async (req: Request, res: Response) => {
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

    // The binding is the authorization check. state was minted by /connect against an
    // authenticated session, so the org it resolves to is the org that started the flow.
    // Reads are single-use, which also makes a replayed callback fail here.
    const flow = await takeOAuthState('shopify', state);
    if (!flow) {
      logger.warn({ hasState: !!state }, 'Shopify OAuth state unknown, expired or already used');
      res.redirect(`${dashboardUrl}?shopify=error`);
      return;
    }

    const nonceCookie = req.cookies?.[oauthNonceCookie('shopify')] as string | undefined;
    clearCookie(res, oauthNonceCookie('shopify'));
    if (!nonceMatches(nonceCookie, flow.nonce)) {
      logger.warn({ hasNonce: !!nonceCookie }, 'shopify OAuth nonce missing or mismatched');
      res.redirect(`${dashboardUrl}?shopify=error`);
      return;
    }

    if (!code) {
      logger.warn({}, 'Shopify OAuth callback missing code');
      res.redirect(`${dashboardUrl}?shopify=error`);
      return;
    }

    try {
      const tokens = await shopifyOAuth.exchangeCode(shop, code);
      const encryptedAccessToken = encrypt(tokens.accessToken);

      const { orgId, userId } = flow;

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

      await enqueueShopifySyncJob(connection.id, 'initial');
      await registerShopifyDailySync(orgId, connection.id);

      trackEvent(orgId, userId, ANALYTICS_EVENTS.INTEGRATION_CONNECTED, {
        provider: 'shopify',
        shop,
      });

      audit(req, {
        orgId,
        userId,
        action: AUDIT_ACTIONS.INTEGRATION_CONNECTED,
        targetType: 'integration',
        targetId: 'shopify',
        metadata: { shop },
      });

      logger.info({ orgId, shop }, 'Shopify connected');
      res.redirect(`${dashboardUrl}?shopify=connected`);
    } catch (error) {
      logger.error({ err: error }, 'Shopify OAuth callback failed');
      res.redirect(`${dashboardUrl}?shopify=error`);
    }
  });

  // Square signs nothing on the callback, so unlike Shopify there is no HMAC to
  // check and the state cookie is the only thing standing between this and a
  // forged redirect.
  router.get('/square/callback', async (req: Request, res: Response) => {
    const { code, state, error } = req.query as Record<string, string | undefined>;
    const dashboardUrl = `${env.APP_URL}/dashboard`;

    if (error) {
      logger.warn({ error }, 'Square OAuth denied by user');
      res.redirect(`${dashboardUrl}?square=denied`);
      return;
    }

    // The binding is the authorization check. state was minted by /connect against an
    // authenticated session, so the org it resolves to is the org that started the flow.
    // Reads are single-use, which also makes a replayed callback fail here.
    const flow = await takeOAuthState('square', state);
    if (!flow) {
      logger.warn({ hasState: !!state }, 'Square OAuth state unknown, expired or already used');
      res.redirect(`${dashboardUrl}?square=error`);
      return;
    }

    const nonceCookie = req.cookies?.[oauthNonceCookie('square')] as string | undefined;
    clearCookie(res, oauthNonceCookie('square'));
    if (!nonceMatches(nonceCookie, flow.nonce)) {
      logger.warn({ hasNonce: !!nonceCookie }, 'square OAuth nonce missing or mismatched');
      res.redirect(`${dashboardUrl}?square=error`);
      return;
    }

    if (!code) {
      logger.warn({}, 'Square OAuth callback missing code');
      res.redirect(`${dashboardUrl}?square=error`);
      return;
    }

    try {
      const { orgId, userId } = flow;

      const tokens = await squareOAuth.exchangeCode(code);

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

      await enqueueSquareSyncJob(connection.id, 'initial');
      await registerSquareDailySync(orgId, connection.id);

      trackEvent(orgId, userId, ANALYTICS_EVENTS.INTEGRATION_CONNECTED, {
        provider: 'square',
        merchantId: tokens.merchantId,
      });

      audit(req, {
        orgId,
        userId,
        action: AUDIT_ACTIONS.INTEGRATION_CONNECTED,
        targetType: 'integration',
        targetId: 'square',
      });

      logger.info({ orgId, merchantId: tokens.merchantId }, 'Square connected');
      res.redirect(`${dashboardUrl}?square=connected`);
    } catch (error) {
      logger.error({ err: error }, 'Square OAuth callback failed');
      res.redirect(`${dashboardUrl}?square=error`);
    }
  });
}
