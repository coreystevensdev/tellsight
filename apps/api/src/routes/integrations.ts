import { Router } from 'express';
import type { Response, Request } from 'express';

import { env, isQbConfigured, isShopifyConfigured, isSquareConfigured } from '../config.js';
import { registerIntegrationCallbacks } from './integrationCallbacks.js';
import { registerSquareIntegrationRoutes } from './squareIntegrationRoutes.js';
import { registerShopifyIntegrationRoutes } from './shopifyIntegrationRoutes.js';
import { registerQuickBooksIntegrationRoutes } from './quickbooksIntegrationRoutes.js';

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

registerQuickBooksIntegrationRoutes(integrationsRouter);

registerShopifyIntegrationRoutes(integrationsRouter);

registerSquareIntegrationRoutes(integrationsRouter);

// Public callback routes (providers redirect the browser here, no auth cookies)
export const integrationsCallbackRouter = Router();
integrationsCallbackRouter.use('/quickbooks', qbGuard);
integrationsCallbackRouter.use('/shopify', shopifyGuard);
integrationsCallbackRouter.use('/square', squareGuard);
registerIntegrationCallbacks(integrationsCallbackRouter);
