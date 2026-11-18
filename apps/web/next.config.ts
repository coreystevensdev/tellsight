import type { NextConfig } from 'next';
import { withSentryConfig } from '@sentry/nextjs/config';


// The API disables helmet's CSP with "CSP is the frontend's job" (index.ts),
// and for a long time the frontend did not hold up its end.
//
// script-src carries 'unsafe-inline' rather than a nonce. Next.js can mint one,
// but only in proxy.ts, which means widening its matcher from the five routes it
// covers to all 24 page routes, and a nonce is per-request so it also opts 21 of
// those 24 out of static rendering. The whole policy would also have to move
// into proxy.ts, since headers() is evaluated at build time and cannot produce a
// per-request value, which would leave the matcher's exclusion regex deciding
// which paths get a CSP at all. See docs/adr/0002-csp-unsafe-inline-over-nonces.md for the full
// measurement and for the fail-open trap that makes a half-done migration worse
// than this.
//
// So this does not stop an injected inline script. It stops what such a script
// would need next: connect-src blocks exfiltration to another origin,
// form-action blocks posting the page somewhere, base-uri blocks rewriting
// every relative URL on the page. React escaping plus no dangerouslySetInnerHTML
// anywhere is still the control that keeps injected script out in the first
// place.
// Plaid Link, the one third-party origin in this policy. Required because the
// SDK must be loaded from Plaid's CDN (their docs: "must be loaded directly from
// the CDN, not bundled or hosted"), Link renders in an iframe served from it,
// and the parent page has to be allowed to reach Plaid's API.
//
// This is a real weakening and it is the directive the rest of this policy leans
// on, so it is worth naming: connect-src 'self' is what makes an 'unsafe-inline'
// script-src defensible, per ADR 0002. What limits the damage is that both
// origins are Plaid's own authenticated API rather than somewhere an attacker
// controls, so an injected script gains a destination it cannot read back out of
// without the victim's Plaid credentials. See the amendment in ADR 0002.
//
// One origin, not both. An earlier version named production and sandbox
// together to dodge the fact that headers() is evaluated at build time while
// PLAID_ENVIRONMENT is read at runtime. NEXT_PUBLIC_PLAID_ENVIRONMENT is
// available at build time and solves that properly, and naming an origin this
// deployment never contacts is breadth with no purpose.
//
// Defaults to sandbox, so forgetting the variable cannot silently allow the
// production origin. A production deployment that forgets it gets a CSP
// violation from Link rather than a wider policy than it asked for.
const PLAID_CDN = 'https://cdn.plaid.com';
const PLAID_LINK_SCRIPT = `${PLAID_CDN}/link/v2/stable/link-initialize.js`;
const PLAID_API_ORIGIN =
  process.env.NEXT_PUBLIC_PLAID_ENVIRONMENT === 'production'
    ? 'https://production.plaid.com'
    : 'https://sandbox.plaid.com';

function csp(): string {
  const dev = process.env.NODE_ENV !== 'production';

  // Sentry is inert without a DSN and is not wired up in production today, but
  // hardcoding the list would silently break error reporting the day someone
  // sets it. Derive the ingest origin instead.
  const sentry = (() => {
    const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;
    if (!dsn) return '';
    try {
      return ` ${new URL(dsn).origin}`;
    } catch {
      return '';
    }
  })();

  const directives = [
    "default-src 'self'",
    // 'unsafe-eval' is the dev bundler's, and must not reach production.
    `script-src 'self' 'unsafe-inline'${dev ? " 'unsafe-eval'" : ''} ${PLAID_LINK_SCRIPT}`,
    // Tailwind and html-to-image both write inline style attributes.
    "style-src 'self' 'unsafe-inline'",
    // html-to-image renders the share card to a data: URL and inlines what it
    // finds; blob: covers the download handoff.
    "img-src 'self' data: blob:",
    // next/font/google self-hosts at build time, so no external font origin.
    "font-src 'self' data:",
    // ws: is the dev HMR socket.
    `connect-src 'self'${sentry} ${PLAID_API_ORIGIN}${dev ? ' ws: wss:' : ''}`,
    // Only exists for Plaid Link. Without the directive its iframe falls through
    // to default-src 'self' and is blocked.
    `frame-src ${PLAID_CDN}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ];

  // No upgrade-insecure-requests. Every source here is 'self' so there is no
  // mixed content for it to upgrade, Caddy already redirects http to https, and
  // it actively breaks anything served over plain http: the browser rewrites
  // Next.js's prefetches to https://localhost:3000 and they die on
  // ERR_SSL_PROTOCOL_ERROR. CI runs a production build over http, so shipping it
  // would have moved a local annoyance into the E2E job.

  return directives.join('; ');
}

const nextConfig: NextConfig = {
  output: 'standalone',
  turbopack: {},
  serverExternalPackages: ['pino-pretty'],
  async headers() {
    return [{
      source: '/(.*)',
      headers: [
        { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        { key: 'Content-Security-Policy', value: csp() },
      ],
    }];
  },
  async rewrites() {
    // fallback, not the plain-array default (afterFiles): afterFiles rewrites
    // are checked before dynamic App Router route handlers, so this generic
    // /api/:path* passthrough was silently winning over dynamic route.ts
    // files (e.g. /api/mute/alert-rule/[token]) whenever the Express path
    // doesn't happen to match the Next.js path 1:1 after stripping /api.
    // fallback only runs once no page or route handler, static or dynamic,
    // has already matched.
    return {
      fallback: [
        {
          source: '/api/:path*',
          destination: `${process.env.API_INTERNAL_URL ?? 'http://api:3001'}/:path*`,
        },
      ],
    };
  },
};

export default withSentryConfig(nextConfig, {
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: process.env.SENTRY_AUTH_TOKEN,
  // upload _next/static chunks so framework frames resolve in stack traces
  widenClientFileUpload: true,
  // auto no-op when authToken is absent, so dev/PR builds stay silent
  silent: true,
  telemetry: false,
});
