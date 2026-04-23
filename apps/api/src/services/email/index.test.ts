import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';

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

import { env } from '../../config.js';
import { logger } from '../../lib/logger.js';
import {
  sendEmail,
  initEmailProvider,
  registerEmailProvider,
  resetEmailProvider,
  getEmailProvider,
} from './index.js';
import { createConsoleProvider } from './providers/console.js';

function Fixture({ name }: { name: string }) {
  return React.createElement(
    'html',
    null,
    React.createElement('body', null, `Hello ${name}`),
  );
}

describe('email service — barrel integration', () => {
  beforeEach(() => {
    resetEmailProvider();
  });

  it('initEmailProvider + sendEmail routes through the registered provider', async () => {
    const logSpy = vi.spyOn(logger, 'info').mockImplementation(() => logger);

    initEmailProvider(env); // picks console (env default is 'console' in test)

    const result = await sendEmail({
      to: 'test@example.com',
      subject: 'Test',
      react: React.createElement(Fixture, { name: 'Corey' }),
      tags: { template: 'test-fixture' },
      correlationId: 'test-corr-1',
    });

    expect(result.status).toBe('captured');
    expect(result.providerMessageId).toMatch(/^console-/);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);

    const captureLog = logSpy.mock.calls.find(
      ([payload]) =>
        typeof payload === 'object' &&
        payload !== null &&
        'outcome' in payload &&
        (payload as { outcome?: string }).outcome === 'captured',
    );
    expect(captureLog).toBeDefined();
    const [payload] = captureLog! as [Record<string, unknown>, string];
    expect(payload.template).toBe('test-fixture');
    expect(payload.renderedHtmlPreview).toContain('Hello Corey');
  });

  it('sendEmail propagates an unregistered-provider error with the boot hint', async () => {
    resetEmailProvider();

    await expect(
      sendEmail({
        to: 'a@b.com',
        subject: 's',
        react: React.createElement('p', null, 'x'),
      }),
    ).rejects.toThrow(/call registerEmailProvider/);
  });

  it('registerEmailProvider can bypass initEmailProvider for custom test providers', () => {
    const custom = createConsoleProvider(env);
    registerEmailProvider(custom);

    expect(getEmailProvider()).toBe(custom);
  });

  it('initEmailProvider with EMAIL_PROVIDER=postmark registers the stub', async () => {
    initEmailProvider({ ...env, EMAIL_PROVIDER: 'postmark' } as typeof env);

    const provider = getEmailProvider();
    expect(provider.name).toBe('postmark');
    await expect(
      provider.send({
        to: 'a@b.com',
        subject: 's',
        react: React.createElement('p', null, 'x'),
      }),
    ).rejects.toThrow(/not implemented/);
  });
});
