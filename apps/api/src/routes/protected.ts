import { Router } from 'express';
import { authMiddleware } from '../middleware/authMiddleware.js';
import { sentryUserContext } from '../lib/sentry.js';
import { inviteRouter } from './invites.js';
import { datasetsRouter } from './datasets.js';
import { datasetsManageRouter } from './datasets-manage.js';
import { aiSummaryRouter } from './aiSummary.js';
import { subscriptionsRouter } from './subscriptions.js';
import { analyticsRouter } from './analytics.js';
import { shareRouter } from './sharing.js';
import { adminRouter } from './admin.js';
import { orgProfileRouter } from './orgProfile.js';
import { orgFinancialsRouter } from './orgFinancials.js';
import { roleGuard } from '../middleware/roleGuard.js';
import { integrationsRouter } from './integrations.js';
import { preferencesEmailRouter } from './preferencesEmail.js';
import { digestRouter } from './digest.js';

const protectedRouter = Router();

// every route mounted on this router requires a valid JWT
protectedRouter.use(authMiddleware);
protectedRouter.use(sentryUserContext);

protectedRouter.use('/invites', inviteRouter);
protectedRouter.use('/datasets', datasetsRouter);
protectedRouter.use('/datasets', datasetsManageRouter);

protectedRouter.use('/ai-summaries', aiSummaryRouter);
protectedRouter.use('/subscriptions', subscriptionsRouter);
protectedRouter.use('/analytics', analyticsRouter);
protectedRouter.use('/shares', shareRouter);
protectedRouter.use('/org', orgProfileRouter);
protectedRouter.use('/org', orgFinancialsRouter);
protectedRouter.use('/integrations', integrationsRouter);
protectedRouter.use('/preferences/email', preferencesEmailRouter);
protectedRouter.use('/digest', digestRouter);
protectedRouter.use('/admin', roleGuard('admin'), adminRouter);

export default protectedRouter;
