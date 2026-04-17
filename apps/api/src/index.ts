import './lib/sentry.js'; // must be first — instruments modules before they load

import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import pinoHttp from 'pino-http';
import { env, isQbConfigured } from './config.js';
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
import { integrationsCallbackRouter } from './routes/integrations.js';
import { initSyncWorker, shutdownWorker } from './services/integrations/worker.js';
import { initScheduler } from './services/integrations/scheduler.js';
import { redis } from './lib/redis.js';
import { queryClient, adminClient } from './lib/db.js';
import { abortAll as abortAllStreams } from './lib/activeStreams.js';
import { Sentry } from './lib/sentry.js';
import { registry, httpRequestDuration } from './lib/metrics.js';

const app = express();

app.set('trust proxy', 1); // BFF proxy is the first hop — needed for correct req.ip in rate limiting

// Prometheus metrics — before helmet so scraper doesn't need to handle security headers.
// Gated by bearer token in production to prevent leaking operational data.
app.get('/metrics', async (req, res) => {
  if (env.NODE_ENV === 'production') {
    const auth = req.headers.authorization;
    if (!auth?.startsWith('Bearer ') || auth.slice(7) !== env.METRICS_TOKEN) {
      res.status(401).end();
      return;
    }
  }
  res.set('Content-Type', registry.contentType);
  res.end(await registry.metrics());
});

// request duration histogram — wraps all routes
app.use((req, res, next) => {
  const end = httpRequestDuration.startTimer();
  res.on('finish', () => {
    const route = req.route?.path ?? req.path;
    end({ method: req.method, route, status: String(res.statusCode) });
  });
  next();
});

app.use(helmet({
  contentSecurityPolicy: false, // API serves JSON/SSE, not HTML — CSP is the frontend's job
  crossOriginResourcePolicy: { policy: 'cross-origin' }, // BFF proxy forwards from a different port
}));
app.use(correlationId);
app.use(stripeWebhookRouter);
app.use(express.json({ limit: '10mb' }));
app.use(cookieParser());
app.use(
  pinoHttp({
    logger,
    autoLogging: {
      ignore: (req) => (req.url?.startsWith('/health') || req.url === '/metrics') ?? false,
    },
  }),
);
app.use(healthRouter);
app.use(authRouter);
app.use('/integrations', rateLimitPublic, integrationsCallbackRouter);
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

  if (isQbConfigured(env)) {
    initSyncWorker();
    await initScheduler();
  } else {
    logger.info({}, 'QuickBooks integration not configured — sync worker disabled');
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
    const aborted = abortAllStreams();
    logger.info({ signal, activeStreams: aborted }, 'Shutdown signal received — draining connections');

    server.close(async () => {
      try {
        // brief pause for aborted streams to flush final SSE events
        if (aborted > 0) await new Promise((r) => setTimeout(r, 500));
        await Sentry.flush(2000);
        await shutdownWorker();
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
