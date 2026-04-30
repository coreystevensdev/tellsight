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
    // deprecated by EMAIL_FROM_ADDRESS (Story 9.1); removed in Story 9.2 after emailDigest/ retires.
    DIGEST_FROM_EMAIL: z.string().email().default('insights@example.com'),

    // Email service (Story 9.1), provider abstraction, console default outside production.
    EMAIL_PROVIDER: z.enum(['resend', 'console', 'postmark']).default('console'),
    // FROM address + mailing address are REQUIRED (no defaults). A placeholder default
    // would let a deployer forget these and ship from example.com / with a fake physical
    // address, the latter is a CAN-SPAM violation. Fail fast at boot instead.
    EMAIL_FROM_ADDRESS: z.string().email(),
    EMAIL_FROM_NAME: z.string().min(1).default('Kiln Insights'),
    EMAIL_REPLY_TO: z.string().email().optional(),
    EMAIL_MAILING_ADDRESS: z.string().min(1),
    // Optional dev-mode HTML capture directory. When set, console provider also writes
    // rendered HTML to disk for visual preview. Unset in CI/prod.
    EMAIL_CAPTURE_DIR: z.string().optional(),

    QUICKBOOKS_CLIENT_ID: z.string().min(1).optional(),
    QUICKBOOKS_CLIENT_SECRET: z.string().min(1).optional(),
    QUICKBOOKS_REDIRECT_URI: z.string().url().optional(),
    QUICKBOOKS_ENVIRONMENT: z.enum(['sandbox', 'production']).default('sandbox'),
    ENCRYPTION_KEY: z.string().length(64).optional(),

    // Only for CI / E2E, set to 'true' to bypass rate limiters entirely.
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
  )
  .refine((data) => !(data.EMAIL_PROVIDER === 'resend' && !data.RESEND_API_KEY), {
    message: 'RESEND_API_KEY required when EMAIL_PROVIDER=resend.',
    path: ['EMAIL_PROVIDER'],
  })
  .refine((data) => !(data.NODE_ENV === 'production' && data.EMAIL_PROVIDER === 'console'), {
    message:
      'EMAIL_PROVIDER=console is not permitted in production, set EMAIL_PROVIDER=resend. Console provider captures sends to logs instead of delivering them; shipping it to prod silently drops customer mail.',
    path: ['EMAIL_PROVIDER'],
  })
  // Reserved test domains per RFC 2606, shipping from one of these in production
  // means Resend rejects every send as an unverified domain, silently.
  .refine(
    (data) =>
      !(data.NODE_ENV === 'production' && /@(example\.(com|org|net)|test|localhost)$/i.test(data.EMAIL_FROM_ADDRESS)),
    {
      message:
        'EMAIL_FROM_ADDRESS uses a reserved test domain (example.com/org/net, .test, localhost) and will be rejected by Resend in production. Set it to a verified sender on your domain.',
      path: ['EMAIL_FROM_ADDRESS'],
    },
  )
  // CAN-SPAM (15 USC §7704(a)(5)(A)(iii)) requires a valid physical postal address
  // in every commercial email. The spec placeholder ("1234 Main St") would be a
  // visible compliance violation; catch it at boot instead of at a lawyer's desk.
  .refine(
    (data) => !(data.NODE_ENV === 'production' && /1234\s+main\s+st/i.test(data.EMAIL_MAILING_ADDRESS)),
    {
      message:
        'EMAIL_MAILING_ADDRESS looks like the spec placeholder ("1234 Main St..."). CAN-SPAM requires a real physical address in every commercial email, set this to your actual mailing address before shipping to production.',
      path: ['EMAIL_MAILING_ADDRESS'],
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
