import { Router } from 'express';
import { authMiddleware } from '../middleware/authMiddleware.js';
import { inviteRouter } from './invites.js';
import { datasetsRouter } from './datasets.js';
import { aiSummaryRouter } from './aiSummary.js';
import { subscriptionsRouter } from './subscriptions.js';
import { analyticsRouter } from './analytics.js';
import { shareRouter } from './sharing.js';

const protectedRouter = Router();

// every route mounted on this router requires a valid JWT
protectedRouter.use(authMiddleware);

protectedRouter.use('/invites', inviteRouter);
protectedRouter.use('/datasets', datasetsRouter);

protectedRouter.use('/ai-summaries', aiSummaryRouter);
protectedRouter.use('/subscriptions', subscriptionsRouter);
protectedRouter.use('/analytics', analyticsRouter);
protectedRouter.use('/shares', shareRouter);

export default protectedRouter;
