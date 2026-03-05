import { Router } from 'express';
import { authMiddleware } from '../middleware/authMiddleware.js';
import { inviteRouter } from './invites.js';
import { datasetsRouter } from './datasets.js';

const protectedRouter = Router();

// every route mounted on this router requires a valid JWT
protectedRouter.use(authMiddleware);

protectedRouter.use('/invites', inviteRouter);
protectedRouter.use('/datasets', datasetsRouter);

// AI routes need rateLimitAi (per-user, 5/min) — see rateLimiter.ts

export default protectedRouter;
