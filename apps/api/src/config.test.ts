import { describe, it, expect, vi } from 'vitest';

// config.ts calls loadConfig() at module load, which reads process.env. Seed
// the minimum valid env BEFORE the import hoists so the module evaluates.
// Per-test refinement is done through envSchema.safeParse with local overrides.
vi.hoisted(() => {
  Object.assign(process.env, {
    DATABASE_URL: 'postgres://u:p@localhost:5432/db',
    DATABASE_ADMIN_URL: 'postgres://u:p@localhost:5432/db',
    REDIS_URL: 'redis://localhost:6379',
    CLAUDE_API_KEY: 'sk-ant-test',
    STRIPE_SECRET_KEY: 'sk_live_x',
    STRIPE_WEBHOOK_SECRET: 'whsec_x',
    STRIPE_PRICE_ID: 'price_x',
    GOOGLE_CLIENT_ID: 'gci',
    GOOGLE_CLIENT_SECRET: 'gcs',
    JWT_SECRET: 'j'.repeat(32),
    APP_URL: 'http://localhost:3000',
    NODE_ENV: 'development',
  });
});

import { envSchema } from './config.js';

function baseEnv(overrides: Record<string, string> = {}) {
  return {
    DATABASE_URL: 'postgres://u:p@localhost:5432/db',
    DATABASE_ADMIN_URL: 'postgres://u:p@localhost:5432/db',
    REDIS_URL: 'redis://localhost:6379',
    CLAUDE_API_KEY: 'sk-ant-test',
    STRIPE_SECRET_KEY: 'sk_live_x',
    STRIPE_WEBHOOK_SECRET: 'whsec_x',
    STRIPE_PRICE_ID: 'price_x',
    GOOGLE_CLIENT_ID: 'gci',
    GOOGLE_CLIENT_SECRET: 'gcs',
    JWT_SECRET: 'j'.repeat(32),
    APP_URL: 'http://localhost:3000',
    NODE_ENV: 'development',
    ...overrides,
  };
}

describe('envSchema — email refine rules', () => {
  it('accepts EMAIL_PROVIDER=resend when RESEND_API_KEY is set', () => {
    const result = envSchema.safeParse(
      baseEnv({ EMAIL_PROVIDER: 'resend', RESEND_API_KEY: 're_abc' }),
    );
    expect(result.success).toBe(true);
  });

  it('rejects EMAIL_PROVIDER=resend without RESEND_API_KEY', () => {
    const result = envSchema.safeParse(baseEnv({ EMAIL_PROVIDER: 'resend' }));
    expect(result.success).toBe(false);
    if (result.success) return;

    const issue = result.error.issues.find((i) => i.path[0] === 'EMAIL_PROVIDER');
    expect(issue?.message).toMatch(/RESEND_API_KEY required/);
  });

  it('rejects EMAIL_PROVIDER=console in production', () => {
    const result = envSchema.safeParse(
      baseEnv({ NODE_ENV: 'production', EMAIL_PROVIDER: 'console' }),
    );
    expect(result.success).toBe(false);
    if (result.success) return;

    const issue = result.error.issues.find((i) => i.path[0] === 'EMAIL_PROVIDER');
    expect(issue?.message).toMatch(/not permitted in production/);
  });

  it('accepts EMAIL_PROVIDER=resend in production with key set', () => {
    const result = envSchema.safeParse(
      baseEnv({
        NODE_ENV: 'production',
        EMAIL_PROVIDER: 'resend',
        RESEND_API_KEY: 're_prod',
      }),
    );
    expect(result.success).toBe(true);
  });

  it('defaults EMAIL_PROVIDER to "console" when unset outside production', () => {
    const result = envSchema.safeParse(baseEnv());
    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.data.EMAIL_PROVIDER).toBe('console');
    expect(result.data.EMAIL_FROM_NAME).toBe('Kiln Insights');
  });

  it('EMAIL_MAILING_ADDRESS defaults to a non-empty string (CAN-SPAM)', () => {
    const result = envSchema.safeParse(baseEnv());
    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.data.EMAIL_MAILING_ADDRESS.length).toBeGreaterThan(0);
  });
});
