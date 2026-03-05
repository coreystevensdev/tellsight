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
import protectedRouter from './routes/protected.js';
import dashboardRouter from './routes/dashboard.js';
import { redis } from './lib/redis.js';

const app = express();

app.set('trust proxy', 1); // BFF proxy is the first hop — needed for correct req.ip in rate limiting
app.use(correlationId);
// TODO: mount stripe webhook route here — needs raw body, must come before json parser
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
app.use(rateLimitPublic, dashboardRouter);
app.use(rateLimitPublic, protectedRouter);
app.use(errorHandler);

async function start() {
  try {
    // redis.ts uses lazyConnect: true — explicit connect() required here
    await redis.connect();
  } catch (err) {
    logger.error({ err }, 'Redis connect failed — shutting down');
    process.exit(1);
  }

  app.listen(env.PORT, () => {
    logger.info({ port: env.PORT, env: env.NODE_ENV }, 'API server started');
  });
}

start();
