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

  // Bind the same address the caller fetches. listen(0) alone binds the
  // wildcard (address() reports "::"), which can succeed while another process
  // already holds 127.0.0.1 on that exact port, and then every request in the
  // test reaches that process instead. On a developer machine running MCP
  // servers over Streamable HTTP, those answer a plain GET with
  // 406 "Not Acceptable: Client must accept text/event-stream", which is how
  // DW-241 showed up: rateLimiter's dashboard tests asserting 200 and reading
  // 406, all retries failing together because the port is chosen once in
  // beforeAll, and never reproducing on CI, which runs nothing else. Bound to
  // loopback, a taken port fails the bind outright instead.
  const server = await new Promise<http.Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });

  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  return { server, baseUrl, app };
}
