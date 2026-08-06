import './lib/sentry.js'; // must be first, instruments modules before they load

import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import pinoHttp from 'pino-http';
import { env, isQbConfigured, isShopifyConfigured } from './config.js';
import { logger } from './lib/logger.js';
import { correlationId } from './middleware/correlationId.js';
import { errorHandler } from './middleware/errorHandler.js';
import { rateLimitPublic } from './middleware/rateLimiter.js';
import healthRouter from './routes/health.js';
import authRouter from './routes/auth.js';
import { publicInviteRouter } from './routes/invites.js';
import { publicShareRouter } from './routes/sharing.js';
import { publicDigestUnsubscribeRouter } from './routes/digestUnsubscribe.js';
import { digestTrackingRouter } from './routes/digestTracking.js';
import { publicAlertMuteRouter } from './routes/alertMute.js';
import { alertTrackingRouter } from './routes/alertTracking.js';
import protectedRouter from './routes/protected.js';
import dashboardRouter from './routes/dashboard.js';
import { stripeWebhookRouter } from './routes/stripeWebhook.js';
import { resendWebhookRouter } from './routes/resendWebhook.js';
import { integrationsCallbackRouter } from './routes/integrations.js';
import { initSyncWorker, shutdownWorker } from './services/integrations/worker.js';
import { initScheduler } from './services/integrations/scheduler.js';
import { initSyncWorker as initShopifySyncWorker, shutdownWorker as shutdownShopifyWorker } from './services/integrations/shopify/worker.js';
import { initScheduler as initShopifyScheduler } from './services/integrations/shopify/scheduler.js';
import {
  initDigestCronJob,
  initDigestOrchestratorWorker,
  initDigestOrgWorker,
  initDigestSendWorker,
  shutdownDigestCron,
  shutdownDigestWorkers,
  closeDigestQueues,
} from './jobs/digest/index.js';
import {
  initAlertsCronJob,
  initAlertsOrchestratorWorker,
  initAlertsEvaluateOrgWorker,
  initAlertsSendWorker,
  shutdownAlertsCron,
  shutdownAlertsWorkers,
  closeAlertsQueues,
} from './jobs/alerts/index.js';
import {
  initAgentOrchestratorCronJob,
  initAgentOrchestratorWorker,
  initAgentEvaluateOrgWorker,
  shutdownAgentOrchestratorCron,
  shutdownAgentOrchestratorWorkers,
  closeAgentOrchestratorQueues,
} from './jobs/agentOrchestrator/index.js';
import {
  initStatCorrectionsCronJob,
  initStatCorrectionsExpireWorker,
  shutdownStatCorrectionsCron,
  shutdownStatCorrectionsWorker,
  closeStatCorrectionsQueue,
} from './jobs/statCorrections/index.js';
import { initEmailProvider } from './services/email/index.js';
import { redis } from './lib/redis.js';
import { queryClient, adminClient } from './lib/db.js';
import { abortAll as abortAllStreams } from './lib/activeStreams.js';
import { Sentry, setupExpressErrorHandler } from './lib/sentry.js';
import { registry, httpRequestDuration } from './lib/metrics.js';

const app = express();

// Production hop count: Cloudflare (DNS-only) → Vercel edge → Railway → Express = 2 hops
// for browser traffic via BFF. Direct-to-Railway (Stripe webhook, api.{DOMAIN}) is 1 hop,
// but those paths don't rely on req.ip for rate limiting. Local docker-compose is 0 hops,
// so 2 is harmless (Express falls back to socket address). Raise to 3 if Cloudflare
// proxy mode is re-enabled on the apex record.
app.set('trust proxy', 2);

// Prometheus metrics, before helmet so scraper doesn't need to handle security headers.
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

// request duration histogram, wraps all routes
app.use((req, res, next) => {
  const end = httpRequestDuration.startTimer();
  res.on('finish', () => {
    const route = req.route?.path ?? req.path;
    end({ method: req.method, route, status: String(res.statusCode) });
  });
  next();
});

app.use(helmet({
  contentSecurityPolicy: false, // API serves JSON/SSE, not HTML, CSP is the frontend's job
  crossOriginResourcePolicy: { policy: 'cross-origin' }, // BFF proxy forwards from a different port
}));
app.use(correlationId);
app.use(stripeWebhookRouter);
app.use(resendWebhookRouter);
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
app.use(rateLimitPublic, publicDigestUnsubscribeRouter);
// Tracking endpoints sit OUTSIDE the public rate limiter on purpose. Apple Mail
// Privacy Protection proxies all pixel fetches through shared Apple IPs; a
// 60/min/IP cap silently undercounts opens for any cohort routed through one
// proxy address. The HMAC token is the abuse defense, an unauthenticated hit
// just returns the 42-byte GIF and emits nothing. Click ingest gets the same
// posture for symmetry (corporate proxies share IPs the same way).
app.use(digestTrackingRouter);
app.use(alertTrackingRouter);
// Same posture as digestTrackingRouter: the mute-rule token is the abuse
// defense, no rate limiter needed on top of it.
app.use(publicAlertMuteRouter);
app.use(rateLimitPublic, dashboardRouter);
app.use(rateLimitPublic, protectedRouter);
setupExpressErrorHandler(app);
app.use(errorHandler);

async function start() {
  try {
    await redis.connect();
  } catch (err) {
    logger.error({ err }, 'Redis connect failed, shutting down');
    process.exit(1);
  }

  initEmailProvider(env);

  if (isQbConfigured(env)) {
    initSyncWorker();
    await initScheduler();
  } else {
    logger.info({}, 'QuickBooks integration not configured, sync worker disabled');
  }

  if (isShopifyConfigured(env)) {
    initShopifySyncWorker();
    await initShopifyScheduler();
  } else {
    logger.info({}, 'Shopify integration not configured, sync worker disabled');
  }

  // Email digest pipeline: cron registration is unconditional once the email
  // provider is wired (validated at boot by config.ts refines). Three workers
  // bind to three queues (orchestrator, org, send) with their own concurrency.
  initDigestOrchestratorWorker();
  initDigestOrgWorker();
  initDigestSendWorker();
  await initDigestCronJob();

  // Alerts pipeline: same three-queue shape as digest (orchestrator, evaluate-org,
  // send), fed by this daily cron plus the on-CSV-upload trigger in datasets.ts.
  initAlertsOrchestratorWorker();
  initAlertsEvaluateOrgWorker();
  initAlertsSendWorker();
  await initAlertsCronJob();

  // Agent pipeline: nightly-only, two-queue shape (orchestrator, evaluate-org).
  // No send queue -- auto_notify findings persist and fold into the next
  // weekly digest instead of sending their own email.
  initAgentOrchestratorWorker();
  initAgentEvaluateOrgWorker();
  await initAgentOrchestratorCronJob();

  // Stat corrections: daily sweep flips approved Tier 2 corrections to
  // 'expired' once expiresAt passes, without this an approved correction
  // would suppress its stat forever.
  initStatCorrectionsExpireWorker();
  await initStatCorrectionsCronJob();

  const server = app.listen(env.PORT, () => {
    logger.info({ port: env.PORT, env: env.NODE_ENV }, 'API server started');
  });

  // SSE streams can run up to 15s, give them time to finish
  server.keepAliveTimeout = 20_000;

  let shuttingDown = false;

  async function shutdown(signal: string) {
    if (shuttingDown) return;
    shuttingDown = true;
    const aborted = abortAllStreams();
    logger.info({ signal, activeStreams: aborted }, 'Shutdown signal received, draining connections');

    server.close(async () => {
      try {
        // brief pause for aborted streams to flush final SSE events
        if (aborted > 0) await new Promise((r) => setTimeout(r, 500));
        await Sentry.flush(2000);
        await shutdownDigestCron();
        await shutdownDigestWorkers();
        await closeDigestQueues();
        await shutdownAlertsCron();
        await shutdownAlertsWorkers();
        await closeAlertsQueues();
        await shutdownAgentOrchestratorCron();
        await shutdownAgentOrchestratorWorkers();
        await closeAgentOrchestratorQueues();
        await shutdownStatCorrectionsCron();
        await shutdownStatCorrectionsWorker();
        await closeStatCorrectionsQueue();
        await shutdownWorker();
        await shutdownShopifyWorker();
        await redis.quit();
        await queryClient.end({ timeout: 5 });
        await adminClient.end({ timeout: 5 });
        logger.info({}, 'All connections closed, exiting');
        process.exit(0);
      } catch (err) {
        logger.error({ err }, 'Error during connection cleanup');
        process.exit(1);
      }
    });

    // hard kill if drain takes too long (30s covers worst-case SSE + query finish)
    setTimeout(() => {
      logger.error({}, 'Graceful shutdown timed out, forcing exit');
      process.exit(1);
    }, 30_000).unref();
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

start();
