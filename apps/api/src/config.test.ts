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
    EMAIL_FROM_ADDRESS: 'insights@kiln.test.local',
    EMAIL_MAILING_ADDRESS: '123 Real Address, Denver, CO 80202',
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
    PUBLIC_API_URL: 'https://api.kiln.app',
    NODE_ENV: 'development',
    EMAIL_FROM_ADDRESS: 'insights@kiln.app',
    EMAIL_MAILING_ADDRESS: '500 Real St, Denver, CO 80202',
    ...overrides,
  };
}

describe('envSchema, email provider coupling', () => {
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

  it('accepts EMAIL_PROVIDER=resend in production with key + webhook secret set', () => {
    const result = envSchema.safeParse(
      baseEnv({
        NODE_ENV: 'production',
        EMAIL_PROVIDER: 'resend',
        RESEND_API_KEY: 're_prod',
        RESEND_WEBHOOK_SECRET: 'whsec_prod',
        EMAIL_FROM_NAME: 'Acme Insights',
      }),
    );
    expect(result.success).toBe(true);
  });

  it('rejects EMAIL_PROVIDER=resend in production without RESEND_WEBHOOK_SECRET', () => {
    const result = envSchema.safeParse(
      baseEnv({
        NODE_ENV: 'production',
        EMAIL_PROVIDER: 'resend',
        RESEND_API_KEY: 're_prod',
      }),
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path[0] === 'RESEND_WEBHOOK_SECRET');
      expect(issue?.message).toMatch(/RESEND_WEBHOOK_SECRET required/);
    }
  });

  it('defaults EMAIL_PROVIDER to "console" outside production', () => {
    const result = envSchema.safeParse(baseEnv());
    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.data.EMAIL_PROVIDER).toBe('console');
    expect(result.data.EMAIL_FROM_NAME).toBe('Kiln Insights');
  });
});

describe('envSchema, CAN-SPAM + delivery guards (no placeholder defaults)', () => {
  it('requires EMAIL_FROM_ADDRESS, fails when omitted', () => {
    const env = baseEnv();
    delete (env as Record<string, string>).EMAIL_FROM_ADDRESS;
    const result = envSchema.safeParse(env);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.some((i) => i.path[0] === 'EMAIL_FROM_ADDRESS')).toBe(true);
  });

  it('requires EMAIL_MAILING_ADDRESS, fails when omitted', () => {
    const env = baseEnv();
    delete (env as Record<string, string>).EMAIL_MAILING_ADDRESS;
    const result = envSchema.safeParse(env);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.some((i) => i.path[0] === 'EMAIL_MAILING_ADDRESS')).toBe(true);
  });

  it('rejects reserved @example.com FROM address in production', () => {
    const result = envSchema.safeParse(
      baseEnv({
        NODE_ENV: 'production',
        EMAIL_PROVIDER: 'resend',
        RESEND_API_KEY: 're_prod',
        EMAIL_FROM_ADDRESS: 'insights@example.com',
      }),
    );

    expect(result.success).toBe(false);
    if (result.success) return;
    const issue = result.error.issues.find((i) => i.path[0] === 'EMAIL_FROM_ADDRESS');
    expect(issue?.message).toMatch(/reserved test domain/);
  });

  it('rejects the "1234 Main St" placeholder mailing address in production', () => {
    const result = envSchema.safeParse(
      baseEnv({
        NODE_ENV: 'production',
        EMAIL_PROVIDER: 'resend',
        RESEND_API_KEY: 're_prod',
        EMAIL_MAILING_ADDRESS: 'Kiln Insights, 1234 Main St, Denver, CO 80202, USA',
      }),
    );

    expect(result.success).toBe(false);
    if (result.success) return;
    const issue = result.error.issues.find((i) => i.path[0] === 'EMAIL_MAILING_ADDRESS');
    expect(issue?.message).toMatch(/placeholder/i);
  });

  it('rejects the "Kiln Insights" placeholder sender name in production', () => {
    const result = envSchema.safeParse(
      baseEnv({
        NODE_ENV: 'production',
        EMAIL_PROVIDER: 'resend',
        RESEND_API_KEY: 're_prod',
        RESEND_WEBHOOK_SECRET: 'whsec_prod',
        EMAIL_FROM_NAME: 'Kiln Insights',
      }),
    );

    expect(result.success).toBe(false);
    if (result.success) return;
    const issue = result.error.issues.find((i) => i.path[0] === 'EMAIL_FROM_NAME');
    expect(issue?.message).toMatch(/placeholder/i);
  });

  it('rejects a case/whitespace variant of the placeholder sender name in production', () => {
    const result = envSchema.safeParse(
      baseEnv({
        NODE_ENV: 'production',
        EMAIL_PROVIDER: 'resend',
        RESEND_API_KEY: 're_prod',
        RESEND_WEBHOOK_SECRET: 'whsec_prod',
        EMAIL_FROM_NAME: ' kiln insights ',
      }),
    );

    expect(result.success).toBe(false);
    if (result.success) return;
    const issue = result.error.issues.find((i) => i.path[0] === 'EMAIL_FROM_NAME');
    expect(issue?.message).toMatch(/placeholder/i);
  });

  it('accepts a real EMAIL_FROM_NAME in production', () => {
    const result = envSchema.safeParse(
      baseEnv({
        NODE_ENV: 'production',
        EMAIL_PROVIDER: 'resend',
        RESEND_API_KEY: 're_prod',
        RESEND_WEBHOOK_SECRET: 'whsec_prod',
        EMAIL_FROM_NAME: 'Acme Insights',
      }),
    );
    expect(result.success).toBe(true);
  });

  it('rejects localhost PUBLIC_API_URL in production', () => {
    const result = envSchema.safeParse(
      baseEnv({
        NODE_ENV: 'production',
        EMAIL_PROVIDER: 'resend',
        RESEND_API_KEY: 're_prod',
        RESEND_WEBHOOK_SECRET: 'whsec_prod',
        PUBLIC_API_URL: 'http://localhost:3001',
      }),
    );

    expect(result.success).toBe(false);
    if (result.success) return;
    const issue = result.error.issues.find((i) => i.path[0] === 'PUBLIC_API_URL');
    expect(issue?.message).toMatch(/localhost/i);
  });

  it('accepts a real public origin for PUBLIC_API_URL in production', () => {
    const result = envSchema.safeParse(
      baseEnv({
        NODE_ENV: 'production',
        EMAIL_PROVIDER: 'resend',
        RESEND_API_KEY: 're_prod',
        RESEND_WEBHOOK_SECRET: 'whsec_prod',
        PUBLIC_API_URL: 'https://api.example.app',
        EMAIL_FROM_NAME: 'Acme Insights',
      }),
    );
    expect(result.success).toBe(true);
  });

  it('uses the localhost default for PUBLIC_API_URL outside production when unset', () => {
    const env = baseEnv();
    delete (env as Record<string, string>).PUBLIC_API_URL;
    const result = envSchema.safeParse(env);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.PUBLIC_API_URL).toBe('http://localhost:3001');
  });

  it('allows @example.* addresses outside production (dev / test / CI)', () => {
    const result = envSchema.safeParse(
      baseEnv({ NODE_ENV: 'development', EMAIL_FROM_ADDRESS: 'dev@example.com' }),
    );
    expect(result.success).toBe(true);
  });
});
