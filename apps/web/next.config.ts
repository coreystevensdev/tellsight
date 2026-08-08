import type { NextConfig } from 'next';
import { withSentryConfig } from '@sentry/nextjs';

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
