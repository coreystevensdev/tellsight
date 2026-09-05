import { timingSafeEqual } from 'node:crypto';

import { Router } from 'express';

import { env } from '../config.js';
import { registry } from '../lib/metrics.js';

export const metricsRouter = Router();

// Mounted before helmet so the scraper does not have to handle security
// headers, and outside every rate limiter. That makes this check the only thing
// in front of request volumes, error rates and AI spend.
//
// Lives here rather than inline in index.ts because index.ts calls listen() at
// module scope: nothing could import it, so the guard could only ever be checked
// by reading the source text, and a source scan cannot tell an enforced gate
// from `production && false`.
metricsRouter.get('/metrics', async (req, res) => {
  if (env.NODE_ENV === 'production') {
    if (!isAuthorized(req.headers.authorization)) {
      res.status(401).end();
      return;
    }
  }

  res.set('Content-Type', registry.contentType);
  res.end(await registry.metrics());
});

// Exported for the empty-token case, which no HTTP client can reach: Node's
// parser trims trailing whitespace, so `Authorization: Bearer ` arrives as
// `Bearer` and fails the scheme check first. The guard still matters, because an
// empty configured token and an empty presented one are two zero-length buffers
// and timingSafeEqual reports those equal.
//
// Constant time, matching how the digest and alert tokens compare. A plain !==
// returns on the first differing byte, which leaks the token prefix to anyone
// who can measure the response.
export function isAuthorized(header: string | undefined): boolean {
  if (!header?.startsWith('Bearer ')) return false;
  if (!env.METRICS_TOKEN) return false;

  const provided = Buffer.from(header.slice(7));
  const expected = Buffer.from(env.METRICS_TOKEN);
  if (provided.length !== expected.length) return false;

  return timingSafeEqual(provided, expected);
}
