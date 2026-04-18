import { Router } from 'express';
import { authMiddleware } from '../middleware/authMiddleware.js';
import { sentryUserContext } from '../lib/sentry.js';
import { inviteRouter } from './invites.js';
import { datasetsRouter } from './datasets.js';
import { datasetManagementRouter } from './datasetManagement.js';
import { aiSummaryRouter } from './aiSummary.js';
import { subscriptionsRouter } from './subscriptions.js';
import { analyticsRouter } from './analytics.js';
import { shareRouter } from './sharing.js';
import { adminRouter } from './admin.js';
import { orgProfileRouter } from './orgProfile.js';
import { roleGuard } from '../middleware/roleGuard.js';
import { integrationsRouter } from './integrations.js';
import { digestPreferencesRouter } from './digestPreferences.js';

const protectedRouter = Router();

// every route mounted on this router requires a valid JWT
protectedRouter.use(authMiddleware);
protectedRouter.use(sentryUserContext);

protectedRouter.use('/invites', inviteRouter);
protectedRouter.use('/datasets', datasetsRouter);
protectedRouter.use('/datasets', datasetManagementRouter);

protectedRouter.use('/ai-summaries', aiSummaryRouter);
protectedRouter.use('/subscriptions', subscriptionsRouter);
protectedRouter.use('/analytics', analyticsRouter);
protectedRouter.use('/shares', shareRouter);
protectedRouter.use('/org', orgProfileRouter);
protectedRouter.use('/integrations', integrationsRouter);
protectedRouter.use('/preferences', digestPreferencesRouter);
protectedRouter.use('/admin', roleGuard('admin'), adminRouter);

export default protectedRouter;
