import type { CookieOptions } from 'express';
import { env } from '../config.js';

// Session cookies must survive the BFF hop (browser → Vercel → Railway) and,
// in multi-host production setups, be readable across `{DOMAIN}` and `api.{DOMAIN}`.
// Host-only cookies work fine when the browser only ever sees `{DOMAIN}`, but
// cross-subdomain reads need an explicit Domain directive. We gate that on the
// COOKIE_DOMAIN env var so local docker-compose and Railway-bootstrap URLs
// (where a Domain directive would be rejected by the browser) stay host-only.
const isProduction = env.NODE_ENV === 'production';

export function sessionCookieOptions(maxAgeSeconds: number): CookieOptions {
  return {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
    path: '/',
    maxAge: maxAgeSeconds * 1000,
    ...(env.COOKIE_DOMAIN ? { domain: env.COOKIE_DOMAIN } : {}),
  };
}

export function clearCookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
    path: '/',
    ...(env.COOKIE_DOMAIN ? { domain: env.COOKIE_DOMAIN } : {}),
  };
}
