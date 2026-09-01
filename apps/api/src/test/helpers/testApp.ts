import express from 'express';
import cookieParser from 'cookie-parser';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { correlationId } from '../../middleware/correlationId.js';
import { errorHandler } from '../../middleware/errorHandler.js';

type AppSetup = (app: express.Express) => void;

/**
 * Spins up a throwaway Express app with the standard middleware skeleton
 * (correlationId, json, cookieParser, errorHandler). `setup` mounts routes
 * after the body parsers, which is where almost everything belongs.
 *
 * `opts.beforeParsers` mounts routes *ahead* of express.json(), mirroring
 * index.ts, where the Stripe and Resend webhook routers sit above the parser
 * because they need the unparsed body for signature verification. Mounting
 * those through `setup` instead makes their express.raw() a no-op: json has
 * already consumed the stream, so the handler sees a parsed object and the
 * test proves nothing about the raw path.
 *
 * Returns the running server and its base URL. Caller is responsible
 * for closing the server in afterAll.
 */
export async function createTestApp(setup: AppSetup, opts: { beforeParsers?: AppSetup } = {}) {
  const app = express();
  app.use(correlationId);

  opts.beforeParsers?.(app);

  app.use(express.json());
  app.use(cookieParser());

  setup(app);

  app.use(errorHandler);

  const server = await new Promise<http.Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });

  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  return { server, baseUrl, app };
}
