import express from 'express';
import cookieParser from 'cookie-parser';
import pinoHttp from 'pino-http';
import { env } from './config.js';
import { logger } from './lib/logger.js';
import { correlationId } from './middleware/correlationId.js';
import { errorHandler } from './middleware/errorHandler.js';
import { rateLimitPublic } from './middleware/rateLimiter.js';
import healthRouter from './routes/health.js';
import authRouter from './routes/auth.js';
import { publicInviteRouter } from './routes/invites.js';
import { publicShareRouter } from './routes/sharing.js';
import protectedRouter from './routes/protected.js';
import dashboardRouter from './routes/dashboard.js';
import { stripeWebhookRouter } from './routes/stripeWebhook.js';
import { redis } from './lib/redis.js';
import { queryClient, adminClient } from './lib/db.js';

const app = express();

app.set('trust proxy', 1); // BFF proxy is the first hop — needed for correct req.ip in rate limiting
app.use(correlationId);
app.use(stripeWebhookRouter);
app.use(express.json({ limit: '10mb' }));
app.use(cookieParser());
app.use(
  pinoHttp({
    logger,
    autoLogging: {
      ignore: (req) => req.url === '/health',
    },
  }),
);
app.use(healthRouter);
app.use(authRouter);
app.use(rateLimitPublic, publicInviteRouter);
app.use(rateLimitPublic, publicShareRouter);
app.use(rateLimitPublic, dashboardRouter);
app.use(rateLimitPublic, protectedRouter);
app.use(errorHandler);

async function start() {
  try {
    await redis.connect();
  } catch (err) {
    logger.error({ err }, 'Redis connect failed — shutting down');
    process.exit(1);
  }

  const server = app.listen(env.PORT, () => {
    logger.info({ port: env.PORT, env: env.NODE_ENV }, 'API server started');
  });

  // SSE streams can run up to 15s — give them time to finish
  server.keepAliveTimeout = 20_000;

  let shuttingDown = false;

  async function shutdown(signal: string) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Shutdown signal received — draining connections');

    server.close(async () => {
      try {
        await redis.quit();
        await queryClient.end({ timeout: 5 });
        await adminClient.end({ timeout: 5 });
        logger.info({}, 'All connections closed — exiting');
        process.exit(0);
      } catch (err) {
        logger.error({ err }, 'Error during connection cleanup');
        process.exit(1);
      }
    });

    // hard kill if drain takes too long (30s covers worst-case SSE + query finish)
    setTimeout(() => {
      logger.error({}, 'Graceful shutdown timed out — forcing exit');
      process.exit(1);
    }, 30_000).unref();
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

start();
