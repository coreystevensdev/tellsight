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
    STRIPE_SECRET_KEY: 'sk_test_x',
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
  // The two Stripe guards are mirror images, so any fixed key here is invalid in
  // one env or the other. Follow NODE_ENV, and let a test that is about the key
  // override it.
  const nodeEnv = overrides.NODE_ENV ?? 'development';
  return {
    DATABASE_URL: 'postgres://u:p@localhost:5432/db',
    DATABASE_ADMIN_URL: 'postgres://u:p@localhost:5432/db',
    REDIS_URL: 'redis://localhost:6379',
    CLAUDE_API_KEY: 'sk-ant-test',
    STRIPE_SECRET_KEY: nodeEnv === 'production' ? 'sk_live_x' : 'sk_test_x',
    STRIPE_WEBHOOK_SECRET: 'whsec_x',
    STRIPE_PRICE_ID: 'price_x',
    GOOGLE_CLIENT_ID: 'gci',
    GOOGLE_CLIENT_SECRET: 'gcs',
    JWT_SECRET: 'j'.repeat(32),
    APP_URL: 'http://localhost:3000',
    PUBLIC_API_URL: 'https://api.kiln.app',
    NODE_ENV: nodeEnv,
    EMAIL_FROM_ADDRESS: 'insights@kiln.app',
    EMAIL_MAILING_ADDRESS: '500 Real St, Denver, CO 80202',
    ...overrides,
  };
}

// Production has email requirements of its own, so a Stripe test that only
// asserts "rejected" can pass on an unrelated issue. These keep it honest.
function prodEnv(overrides: Record<string, string> = {}) {
  return baseEnv({
    NODE_ENV: 'production',
    EMAIL_PROVIDER: 'resend',
    RESEND_API_KEY: 're_abc',
    RESEND_WEBHOOK_SECRET: 'whsec_resend',
    EMAIL_FROM_NAME: 'Tellsight',
    ...overrides,
  });
}

function stripeKeyIssue(result: ReturnType<typeof envSchema.safeParse>) {
  if (result.success) return null;
  return result.error.issues.find((i) => i.path[0] === 'STRIPE_SECRET_KEY')?.message ?? null;
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

describe('envSchema, production guards on non-email settings', () => {
  // The only refine in the file that had no test. A test key in production takes
  // real payments to nowhere, and the failure is silent until someone checks
  // Stripe.
  it('rejects a Stripe test key in production', () => {
    const result = envSchema.safeParse(
      baseEnv({ NODE_ENV: 'production', STRIPE_SECRET_KEY: 'sk_test_x' }),
    );
    expect(result.success).toBe(false);
    if (result.success) return;

    const issue = result.error.issues.find((i) => i.path[0] === 'STRIPE_SECRET_KEY');
    expect(issue?.message).toMatch(/must be a live key/);
  });

  // computeCost prefix-matches the pricing table and returns null for a model it
  // does not know, and applyCostGate returns on null before reaching
  // exceedsBudget, so both the rolling cap and the absolute ceiling stop
  // applying. A typo in a model id should not be able to buy that.
  it('rejects a model the pricing table has no entry for', () => {
    const result = envSchema.safeParse(baseEnv({ CLAUDE_MODEL: 'claude-sonnet-9' }));

    expect(result.success).toBe(false);
    if (result.success) return;
    const issue = result.error.issues.find((i) => i.path[0] === 'CLAUDE_MODEL');
    expect(issue?.message).toMatch(/pricing table/i);
  });

  it('rejects an unpriced tool model too, so the split cannot open a hole', () => {
    const result = envSchema.safeParse(baseEnv({ CLAUDE_MODEL_TOOLS: 'claude-sonnet-9' }));

    expect(result.success).toBe(false);
    if (result.success) return;
    const issue = result.error.issues.find((i) => i.path[0] === 'CLAUDE_MODEL_TOOLS');
    expect(issue?.message).toMatch(/pricing table/i);
  });

  it('accepts a priced tool model, and accepts none at all', () => {
    expect(envSchema.safeParse(baseEnv({ CLAUDE_MODEL_TOOLS: 'claude-haiku-4-5' })).success).toBe(true);
    expect(envSchema.safeParse(baseEnv()).success).toBe(true);
  });

  it.each([
    ['the dated default', 'claude-sonnet-4-5-20250929'],
    ['a bare prefix', 'claude-haiku-4-5'],
    ['a priced opus', 'claude-opus-4-7'],
  ])('accepts %s', (_label, model) => {
    expect(envSchema.safeParse(baseEnv({ CLAUDE_MODEL: model })).success).toBe(true);
  });

  // A public demo has no real customers to ship a broken payment flow to, and a
  // live key there means a visitor clicking Upgrade meets a real payment form.
  // The exception has to be asked for, so a deployment cannot drift into it.
  it('allows a Stripe test key in production when the deployment asks for it', () => {
    const result = envSchema.safeParse(
      prodEnv({ STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_TEST_MODE_IN_PRODUCTION: 'true' }),
    );
    expect(result.success).toBe(true);
  });

  it('does not treat an unset opt-in as permission', () => {
    const result = envSchema.safeParse(
      prodEnv({ STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_TEST_MODE_IN_PRODUCTION: 'false' }),
    );
    expect(stripeKeyIssue(result)).toMatch(/must be a live key/);
  });

  // The opt-in is about test keys only. It must not become a way to run a live
  // key on a laptop, which is the refine that costs real money.
  it('still rejects a live key outside production even with the opt-in set', () => {
    const result = envSchema.safeParse(
      baseEnv({ STRIPE_SECRET_KEY: 'sk_live_x', STRIPE_TEST_MODE_IN_PRODUCTION: 'true' }),
    );
    expect(stripeKeyIssue(result)).toMatch(/must be a test key/);
  });

  // The billing page's demo notice reads the flag, not the key, so this pairing
  // would print "pay with a test card" above a checkout that takes a real one.
  // Production is the only place a live key is legal, so this is where it bites.
  it('rejects the test-mode opt-in alongside a live key in production', () => {
    const result = envSchema.safeParse(
      prodEnv({ STRIPE_SECRET_KEY: 'sk_live_x', STRIPE_TEST_MODE_IN_PRODUCTION: 'true' }),
    );
    expect(result.success).toBe(false);
    const msg = result.success
      ? ''
      : result.error.issues.map((i) => i.message).join(' ');
    expect(msg).toMatch(/pay with a test card/);
  });

  it('accepts a live Stripe key in production', () => {
    const result = envSchema.safeParse(
      baseEnv({
        NODE_ENV: 'production',
        STRIPE_SECRET_KEY: 'sk_live_y',
        EMAIL_PROVIDER: 'resend',
        RESEND_API_KEY: 're_abc',
        RESEND_WEBHOOK_SECRET: 'whsec_abc',
        EMAIL_FROM_NAME: 'Tellsight',
      }),
    );
    expect(result.success).toBe(true);
  });

  it('rejects a live Stripe key outside production', () => {
    const result = envSchema.safeParse(baseEnv({ STRIPE_SECRET_KEY: 'sk_live_z' }));
    expect(result.success).toBe(false);
    if (result.success) return;

    const issue = result.error.issues.find((i) => i.path[0] === 'STRIPE_SECRET_KEY');
    expect(issue?.message).toMatch(/must be a test key/);
  });

  it('leaves a test key alone outside production', () => {
    const result = envSchema.safeParse(baseEnv({ STRIPE_SECRET_KEY: 'sk_test_x' }));
    expect(result.success).toBe(true);
  });

  it('defaults DISABLE_RATE_LIMIT to "false"', () => {
    const result = envSchema.safeParse(baseEnv());
    expect(result.success && result.data.DISABLE_RATE_LIMIT).toBe('false');
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
