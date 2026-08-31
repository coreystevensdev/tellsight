import type { NextConfig } from 'next';
import { withSentryConfig } from '@sentry/nextjs';


// The API disables helmet's CSP with "CSP is the frontend's job" (index.ts),
// and for a long time the frontend did not hold up its end.
//
// script-src carries 'unsafe-inline' rather than a nonce. Next.js can use a
// nonce, but only one minted per request in proxy.ts, and that means widening
// its matcher from the four protected routes to every route. proxy.ts is the
// file with the "dashboard is public, never redirect from /dashboard" rule on
// it, and running it everywhere to satisfy a defence-in-depth header is a worse
// trade than the weaker script-src. Nonces also opt every page out of static
// rendering.
//
// So this does not stop an injected inline script. It stops what such a script
// would need next: connect-src blocks exfiltration to another origin,
// form-action blocks posting the page somewhere, base-uri blocks rewriting
// every relative URL on the page. React escaping plus no dangerouslySetInnerHTML
// anywhere is still the control that keeps injected script out in the first
// place.
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
    `script-src 'self' 'unsafe-inline'${dev ? " 'unsafe-eval'" : ''}`,
    // Tailwind and html-to-image both write inline style attributes.
    "style-src 'self' 'unsafe-inline'",
    // html-to-image renders the share card to a data: URL and inlines what it
    // finds; blob: covers the download handoff.
    "img-src 'self' data: blob:",
    // next/font/google self-hosts at build time, so no external font origin.
    "font-src 'self' data:",
    // ws: is the dev HMR socket.
    `connect-src 'self'${sentry}${dev ? ' ws: wss:' : ''}`,
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
