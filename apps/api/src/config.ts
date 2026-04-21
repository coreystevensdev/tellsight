import { z } from 'zod';

export const envSchema = z
  .object({
    DATABASE_URL: z.string().url(),
    DATABASE_ADMIN_URL: z.string().url(),
    REDIS_URL: z.string().url(),
    CLAUDE_API_KEY: z.string().min(1),
    CLAUDE_MODEL: z.string().default('claude-sonnet-4-5-20250929'),
    STRIPE_SECRET_KEY: z.string().min(1),
    STRIPE_WEBHOOK_SECRET: z.string().min(1),
    STRIPE_PRICE_ID: z.string().min(1),
    GOOGLE_CLIENT_ID: z.string().min(1),
    GOOGLE_CLIENT_SECRET: z.string().min(1),
    JWT_SECRET: z.string().min(32),
    APP_URL: z.string().url(),
    COOKIE_DOMAIN: z.string().min(1).optional(),
    NODE_ENV: z.enum(['development', 'production', 'test']),
    PORT: z.coerce.number().default(3001),
    ANALYTICS_RETENTION_DAYS: z.coerce.number().int().positive().default(90),
    METRICS_TOKEN: z.string().min(16).optional(),

    SENTRY_DSN: z.string().url().optional(),

    RESEND_API_KEY: z.string().min(1).optional(),
    DIGEST_FROM_EMAIL: z.string().email().default('insights@example.com'),

    QUICKBOOKS_CLIENT_ID: z.string().min(1).optional(),
    QUICKBOOKS_CLIENT_SECRET: z.string().min(1).optional(),
    QUICKBOOKS_REDIRECT_URI: z.string().url().optional(),
    QUICKBOOKS_ENVIRONMENT: z.enum(['sandbox', 'production']).default('sandbox'),
    ENCRYPTION_KEY: z.string().length(64).optional(),

    // Only for CI / E2E — set to 'true' to bypass rate limiters entirely.
    // Parallel Playwright workers blow the 60/min public limit otherwise.
    DISABLE_RATE_LIMIT: z.enum(['true', 'false']).default('false'),
  })
  .refine(
    (data) => !(data.NODE_ENV === 'production' && data.STRIPE_SECRET_KEY.startsWith('sk_test_')),
    {
      message:
        'STRIPE_SECRET_KEY must be a live key (sk_live_*) when NODE_ENV=production. A test key (sk_test_*) in production silently ships a broken payment flow to real users.',
      path: ['STRIPE_SECRET_KEY'],
    },
  );

export type Env = z.infer<typeof envSchema>;

export function isDigestConfigured(cfg: Env): boolean {
  return !!cfg.RESEND_API_KEY;
}

export function isQbConfigured(cfg: Env): boolean {
  return !!(
    cfg.QUICKBOOKS_CLIENT_ID &&
    cfg.QUICKBOOKS_CLIENT_SECRET &&
    cfg.QUICKBOOKS_REDIRECT_URI &&
    cfg.ENCRYPTION_KEY
  );
}

function loadConfig(): Env {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    const formatted = result.error.format();
    const missing = Object.entries(formatted)
      .filter(([key]) => key !== '_errors')
      .map(([key, val]) => `  ${key}: ${(val as { _errors: string[] })._errors.join(', ')}`)
      .join('\n');
    throw new Error(`Missing or invalid environment variables:\n${missing}`);
  }
  return result.data;
}

export const env = loadConfig();
