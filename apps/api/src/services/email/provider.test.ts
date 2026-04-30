import { describe, it, expect, beforeEach, vi } from 'vitest';

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
    EMAIL_MAILING_ADDRESS: '500 Test Ave, Denver, CO 80202',
  });
});

import type { EmailProvider } from './provider.js';
import {
  EmailSendError,
  createPostmarkProvider,
  getEmailProvider,
  registerEmailProvider,
  resetEmailProvider,
} from './provider.js';
import { env } from '../../config.js';

function fakeProvider(name: string): EmailProvider {
  return {
    name,
    send: async () => ({
      status: 'captured',
      providerMessageId: `${name}-msg`,
      durationMs: 1,
    }),
    checkHealth: async () => ({ status: 'ok', latencyMs: 0 }),
  };
}

describe('email provider registry', () => {
  beforeEach(() => {
    resetEmailProvider();
  });

  it('throws when getEmailProvider is called before registration', () => {
    expect(() => getEmailProvider()).toThrow(/call registerEmailProvider/);
  });

  it('returns the registered provider', async () => {
    const p = fakeProvider('fake');
    registerEmailProvider(p);

    const provider = getEmailProvider();

    expect(provider.name).toBe('fake');
    const result = await provider.send({
      to: 'a@b.com',
      subject: 's',
      react: { type: 'div', props: {}, key: null } as never,
    });
    expect(result.providerMessageId).toBe('fake-msg');
  });

  it('later registrations replace earlier ones', () => {
    registerEmailProvider(fakeProvider('first'));
    registerEmailProvider(fakeProvider('second'));

    expect(getEmailProvider().name).toBe('second');
  });

  it('reset clears the active provider', () => {
    registerEmailProvider(fakeProvider('fake'));
    resetEmailProvider();

    expect(() => getEmailProvider()).toThrow(/call registerEmailProvider/);
  });

  it('throw message names registerEmailProvider explicitly', () => {
    expect(() => getEmailProvider()).toThrow(
      'Email provider not registered, call registerEmailProvider() at boot',
    );
  });
});

describe('EmailSendError', () => {
  it('carries retryable discriminant + statusCode + cause', () => {
    const original = new Error('upstream 500');
    const err = new EmailSendError('send failed', {
      retryable: true,
      providerStatusCode: 503,
      cause: original,
    });

    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(EmailSendError);
    expect(err.name).toBe('EmailSendError');
    expect(err.retryable).toBe(true);
    expect(err.providerStatusCode).toBe(503);
    expect(err.cause).toBe(original);
  });

  it('allows retryable=false for 4xx classification', () => {
    const err = new EmailSendError('invalid from', {
      retryable: false,
      providerStatusCode: 422,
    });

    expect(err.retryable).toBe(false);
    expect(err.providerStatusCode).toBe(422);
    expect(err.cause).toBeUndefined();
  });
});

describe('createPostmarkProvider stub', () => {
  it('compiles the factory pattern without installing the postmark package', () => {
    const provider = createPostmarkProvider(env);

    expect(provider.name).toBe('postmark');
    expect(typeof provider.send).toBe('function');
    expect(typeof provider.checkHealth).toBe('function');
  });

  it('throws "not implemented" when asked to send', async () => {
    const provider = createPostmarkProvider(env);

    await expect(
      provider.send({ to: 'a@b.com', subject: 's', react: { type: 'div' } as never }),
    ).rejects.toThrow(/not implemented/);
  });

  it('reports health as ok so a misconfigured stub does not page oncall', async () => {
    const health = await createPostmarkProvider(env).checkHealth();
    expect(health.status).toBe('ok');
    expect(health.latencyMs).toBe(0);
  });
});
