import { describe, it, expect, vi, beforeEach } from 'vitest';
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
    EMAIL_PROVIDER: 'resend',
    RESEND_API_KEY: 're_test',
    EMAIL_FROM_ADDRESS: 'insights@kiln.test.local',
    EMAIL_MAILING_ADDRESS: '500 Test Ave, Denver, CO 80202',
  });
});

import { env } from '../../../config.js';
import type { logger as pinoLogger } from '../../../lib/logger.js';
import { createResendProvider } from './resend.js';
import { EmailSendError } from '../provider.js';

const template = () => React.createElement('p', null, 'hello');

type RealLogger = typeof pinoLogger;

function makeFakeLogger() {
  const info = vi.fn();
  const debug = vi.fn();
  const warn = vi.fn();
  const error = vi.fn();
  const instance: Record<string, unknown> = { info, debug, warn, error };
  instance.child = vi.fn(() => instance);
  return { logger: instance as unknown as RealLogger, info, debug, warn, error };
}

function fakeResend(sendImpl: (...args: unknown[]) => unknown) {
  const send = vi.fn(sendImpl);
  return {
    client: { emails: { send } } as never,
    send,
  };
}

describe('resend provider', () => {
  let sentry: { captureException: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    sentry = { captureException: vi.fn() };
  });

  it('sends successfully and returns providerMessageId + durationMs', async () => {
    const { logger, info } = makeFakeLogger();
    const { client, send } = fakeResend(async () => ({
      data: { id: 'msg_abc' },
      error: null,
    }));
    const clock = vi.fn().mockReturnValueOnce(100).mockReturnValueOnce(150);
    const provider = createResendProvider(env, { logger, resend: client, clock, sentry });

    const result = await provider.send({
      to: 'customer@example.com',
      subject: 'Digest',
      react: template(),
      tags: { template: 'digest-weekly' },
      correlationId: 'corr-1',
    });

    expect(result).toEqual({
      status: 'sent',
      providerMessageId: 'msg_abc',
      durationMs: 50,
    });
    expect(send).toHaveBeenCalledTimes(1);

    const [payload] = send.mock.calls[0]! as [Record<string, unknown>];
    expect(payload.from).toBe(`${env.EMAIL_FROM_NAME} <${env.EMAIL_FROM_ADDRESS}>`);
    expect(payload.to).toBe('customer@example.com');
    expect(payload.html).toContain('hello');
    expect(payload.tags).toEqual([{ name: 'template', value: 'digest-weekly' }]);

    expect(info).toHaveBeenCalledTimes(1);
    const [logPayload, logMsg] = info.mock.calls[0]! as [Record<string, unknown>, string];
    expect(logMsg).toBe('email sent');
    expect(logPayload.outcome).toBe('sent');
    expect(logPayload.to).toBe('cu***@example.com');
  });

  it('classifies 5xx as retryable and does NOT capture to Sentry', async () => {
    const { logger, error } = makeFakeLogger();
    const { client } = fakeResend(async () => ({
      data: null,
      error: { statusCode: 503, message: 'upstream down', name: 'internal_server_error' },
    }));
    const provider = createResendProvider(env, { logger, resend: client, sentry });

    const sendPromise = provider.send({ to: 'a@b.com', subject: 's', react: template() });
    await expect(sendPromise).rejects.toBeInstanceOf(EmailSendError);
    await sendPromise.catch((err: EmailSendError) => {
      expect(err.retryable).toBe(true);
      expect(err.providerStatusCode).toBe(503);
    });

    expect(sentry.captureException).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(1);
    const [errPayload] = error.mock.calls[0]! as [Record<string, unknown>];
    expect(errPayload.outcome).toBe('failed');
    expect(errPayload.retryable).toBe(true);
  });

  it('classifies 429 as retryable', async () => {
    const { logger } = makeFakeLogger();
    const { client } = fakeResend(async () => ({
      data: null,
      error: { statusCode: 429, message: 'rate limited', name: 'rate_limit_exceeded' },
    }));
    const provider = createResendProvider(env, { resend: client, sentry, logger });

    await expect(
      provider.send({ to: 'a@b.com', subject: 's', react: template() }),
    ).rejects.toMatchObject({ retryable: true, providerStatusCode: 429 });

    expect(sentry.captureException).not.toHaveBeenCalled();
  });

  it('classifies 4xx as non-retryable and captures to Sentry with tags', async () => {
    const { logger } = makeFakeLogger();
    const { client } = fakeResend(async () => ({
      data: null,
      error: { statusCode: 422, message: 'invalid from', name: 'validation_error' },
    }));
    const provider = createResendProvider(env, { logger, resend: client, sentry });

    await expect(
      provider.send({
        to: 'a@b.com',
        subject: 's',
        react: template(),
        tags: { template: 'welcome' },
      }),
    ).rejects.toMatchObject({ retryable: false, providerStatusCode: 422 });

    expect(sentry.captureException).toHaveBeenCalledTimes(1);
    const [err, ctx] = sentry.captureException.mock.calls[0]! as [
      Error,
      { tags: Record<string, string> },
    ];
    expect(err).toBeInstanceOf(Error);
    expect(ctx.tags).toEqual({ provider: 'email', template: 'welcome', retryable: 'false' });
  });

  it('wraps thrown network errors as retryable', async () => {
    const original = new Error('ECONNRESET');
    const { client } = fakeResend(async () => {
      throw original;
    });
    const { logger } = makeFakeLogger();
    const provider = createResendProvider(env, { resend: client, sentry, logger });

    const sendPromise = provider.send({ to: 'a@b.com', subject: 's', react: template() });
    await expect(sendPromise).rejects.toBeInstanceOf(EmailSendError);
    await sendPromise.catch((err: EmailSendError) => {
      expect(err.retryable).toBe(true);
      expect(err.cause).toBe(original);
    });
  });

  it('does not construct a real Resend client until the first send', async () => {
    const { logger } = makeFakeLogger();
    const provider = createResendProvider(
      { ...env, RESEND_API_KEY: 're_unused' } as typeof env,
      { logger, sentry },
    );

    const health = await provider.checkHealth();
    expect(health.status).toBe('ok');
    expect(health.latencyMs).toBe(0);
  });

  it('checkHealth returns static ok without SDK calls', async () => {
    const { send } = fakeResend(async () => ({ data: { id: 'x' }, error: null }));
    const provider = createResendProvider(env, {
      resend: { emails: { send } } as never,
      sentry,
    });

    const health = await provider.checkHealth();
    expect(health.status).toBe('ok');
    expect(health.latencyMs).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });

  it('composes from-address as "Name <email>"', async () => {
    const { logger } = makeFakeLogger();
    const { client, send } = fakeResend(async () => ({
      data: { id: 'x' },
      error: null,
    }));
    const provider = createResendProvider(
      { ...env, EMAIL_FROM_NAME: 'Kiln', EMAIL_FROM_ADDRESS: 'insights@kiln.app' } as typeof env,
      { resend: client, sentry, logger },
    );

    await provider.send({ to: 'a@b.com', subject: 's', react: template() });

    const [payload] = send.mock.calls[0]! as [Record<string, unknown>];
    expect(payload.from).toBe('Kiln <insights@kiln.app>');
  });

  it('falls back to env.EMAIL_REPLY_TO when opts.replyTo is absent', async () => {
    const { logger } = makeFakeLogger();
    const { client, send } = fakeResend(async () => ({ data: { id: 'x' }, error: null }));
    const provider = createResendProvider(
      { ...env, EMAIL_REPLY_TO: 'hello@kiln.app' } as typeof env,
      { resend: client, sentry, logger },
    );

    await provider.send({ to: 'a@b.com', subject: 's', react: template() });
    const [payload] = send.mock.calls[0]! as [Record<string, unknown>];
    expect(payload.replyTo).toBe('hello@kiln.app');
  });

  it('prefers opts.replyTo over env fallback when both exist', async () => {
    const { logger } = makeFakeLogger();
    const { client, send } = fakeResend(async () => ({ data: { id: 'x' }, error: null }));
    const provider = createResendProvider(
      { ...env, EMAIL_REPLY_TO: 'hello@kiln.app' } as typeof env,
      { resend: client, sentry, logger },
    );

    await provider.send({
      to: 'a@b.com',
      subject: 's',
      react: template(),
      replyTo: 'override@kiln.app',
    });

    const [payload] = send.mock.calls[0]! as [Record<string, unknown>];
    expect(payload.replyTo).toBe('override@kiln.app');
  });

  it('serializes tags to {name,value}[], Resend wire format', async () => {
    const { logger } = makeFakeLogger();
    const { client, send } = fakeResend(async () => ({ data: { id: 'x' }, error: null }));
    const provider = createResendProvider(env, { resend: client, sentry, logger });

    await provider.send({
      to: 'a@b.com',
      subject: 's',
      react: template(),
      tags: { template: 'digest-weekly', orgId: 'org_123' },
    });

    const [payload] = send.mock.calls[0]! as [Record<string, unknown>];
    expect(payload.tags).toEqual([
      { name: 'template', value: 'digest-weekly' },
      { name: 'orgId', value: 'org_123' },
    ]);
  });

  it('passes tags as undefined when caller omits them', async () => {
    const { logger } = makeFakeLogger();
    const { client, send } = fakeResend(async () => ({ data: { id: 'x' }, error: null }));
    const provider = createResendProvider(env, { resend: client, sentry, logger });

    await provider.send({ to: 'a@b.com', subject: 's', react: template() });
    const [payload] = send.mock.calls[0]! as [Record<string, unknown>];
    expect(payload.tags).toBeUndefined();
  });

  it('throws retryable EmailSendError when SDK returns neither id nor error', async () => {
    const { logger, error } = makeFakeLogger();
    const { client } = fakeResend(async () => ({
      data: null,
      error: null,
    }));
    const provider = createResendProvider(env, { logger, resend: client, sentry });

    await expect(
      provider.send({ to: 'a@b.com', subject: 's', react: template() }),
    ).rejects.toMatchObject({ retryable: true });
    expect(error).toHaveBeenCalledTimes(1);
    const [errPayload] = error.mock.calls[0]! as [Record<string, unknown>];
    expect(errPayload.outcome).toBe('failed');
  });

  it('quotes display names containing RFC 5322 special characters', async () => {
    const { logger } = makeFakeLogger();
    const { client, send } = fakeResend(async () => ({ data: { id: 'x' }, error: null }));
    const provider = createResendProvider(
      {
        ...env,
        EMAIL_FROM_NAME: 'Smith, Jones & Co.',
        EMAIL_FROM_ADDRESS: 'hello@kiln.app',
      } as typeof env,
      { resend: client, sentry, logger },
    );

    await provider.send({ to: 'a@b.com', subject: 's', react: template() });
    const [payload] = send.mock.calls[0]! as [Record<string, unknown>];
    expect(payload.from).toBe('"Smith, Jones & Co." <hello@kiln.app>');
  });

  it('escapes embedded quotes and backslashes in display names', async () => {
    const { logger } = makeFakeLogger();
    const { client, send } = fakeResend(async () => ({ data: { id: 'x' }, error: null }));
    const provider = createResendProvider(
      { ...env, EMAIL_FROM_NAME: 'Kiln "Pro" \\ Ops', EMAIL_FROM_ADDRESS: 'hello@kiln.app' } as typeof env,
      { resend: client, sentry, logger },
    );

    await provider.send({ to: 'a@b.com', subject: 's', react: template() });
    const [payload] = send.mock.calls[0]! as [Record<string, unknown>];
    expect(payload.from).toBe('"Kiln \\"Pro\\" \\\\ Ops" <hello@kiln.app>');
  });

  it('treats a null statusCode from Resend as retryable', async () => {
    const { logger } = makeFakeLogger();
    const { client } = fakeResend(async () => ({
      data: null,
      error: { statusCode: null, message: 'unknown', name: 'unknown_error' },
    }));
    const provider = createResendProvider(env, { resend: client, sentry, logger });

    await expect(
      provider.send({ to: 'a@b.com', subject: 's', react: template() }),
    ).rejects.toMatchObject({ retryable: true });
    expect(sentry.captureException).not.toHaveBeenCalled();
  });
});
