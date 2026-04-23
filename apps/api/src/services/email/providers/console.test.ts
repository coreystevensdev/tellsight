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
  });
});

import { env } from '../../../config.js';
import type { logger as pinoLogger } from '../../../lib/logger.js';
import { createConsoleProvider, redactRecipient } from './console.js';

// Explicit vi.fn() references so tests can introspect `.mock.calls` without
// fighting pino's LogFn overloads. Cast back to the pino logger type at
// injection site — the provider only touches the methods we implement here.
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

function makeFakeFs(overrides: Partial<{ writeFile: ReturnType<typeof vi.fn>; mkdir: ReturnType<typeof vi.fn> }> = {}) {
  return {
    writeFile: vi.fn(async () => undefined),
    mkdir: vi.fn(async () => undefined),
    ...overrides,
  };
}

// Minimal React fixture — one element with literal content so render produces
// deterministic HTML. Avoids pulling @react-email/components element wrappers
// into unit tests.
const template = () => React.createElement('p', null, 'hello world');

describe('console provider', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders, logs once, and returns a captured result', async () => {
    const { logger, info } = makeFakeLogger();
    const clock = vi.fn().mockReturnValueOnce(0).mockReturnValueOnce(5);
    const provider = createConsoleProvider(env, { logger, clock });

    const result = await provider.send({
      to: 'customer@example.com',
      subject: 'Weekly digest',
      react: template(),
      tags: { template: 'digest-weekly' },
      correlationId: 'corr-1',
    });

    expect(result.status).toBe('captured');
    expect(result.providerMessageId).toMatch(/^console-[\da-f-]+$/);
    expect(result.durationMs).toBe(5);
    expect(info).toHaveBeenCalledTimes(1);

    const [payload, msg] = info.mock.calls[0]! as [Record<string, unknown>, string];
    expect(msg).toBe('email send captured');
    expect(payload.provider).toBe('console');
    expect(payload.template).toBe('digest-weekly');
    expect(payload.to).toBe('cu***@example.com');
    expect(payload.outcome).toBe('captured');
    expect(payload.correlationId).toBe('corr-1');
    expect(payload.renderedHtmlPreview).toContain('hello world');
  });

  it('generates a correlationId when caller omits it', async () => {
    const { logger, info } = makeFakeLogger();
    const provider = createConsoleProvider(env, { logger });

    await provider.send({ to: 'a@b.com', subject: 's', react: template() });

    const [payload] = info.mock.calls[0]! as [Record<string, unknown>];
    expect(payload.correlationId).toMatch(/^[\da-f-]{36}$/);
  });

  it('defaults template to "unknown" when tags omit it', async () => {
    const { logger, info } = makeFakeLogger();
    const provider = createConsoleProvider(env, { logger });

    await provider.send({ to: 'a@b.com', subject: 's', react: template() });

    const [payload] = info.mock.calls[0]! as [Record<string, unknown>];
    expect(payload.template).toBe('unknown');
  });

  it('writes rendered HTML to disk when EMAIL_CAPTURE_DIR is set', async () => {
    const fs = makeFakeFs();
    const { logger } = makeFakeLogger();
    const provider = createConsoleProvider(
      { ...env, EMAIL_CAPTURE_DIR: '/tmp/kiln-email' } as typeof env,
      { logger, fs },
    );

    await provider.send({
      to: 'a@b.com',
      subject: 's',
      react: template(),
      tags: { template: 'welcome' },
    });

    expect(fs.mkdir).toHaveBeenCalledWith('/tmp/kiln-email', { recursive: true });
    expect(fs.writeFile).toHaveBeenCalledTimes(1);
    const [writtenPath, contents, encoding] = fs.writeFile.mock.calls[0]! as [
      string,
      string,
      string,
    ];
    expect(writtenPath).toMatch(/\/tmp\/kiln-email\/.+-welcome\.html$/);
    expect(contents).toContain('hello world');
    expect(encoding).toBe('utf8');
  });

  it('does not touch the filesystem when EMAIL_CAPTURE_DIR is unset', async () => {
    const fs = makeFakeFs();
    const { logger } = makeFakeLogger();
    const provider = createConsoleProvider(env, { logger, fs });

    await provider.send({ to: 'a@b.com', subject: 's', react: template() });

    expect(fs.writeFile).not.toHaveBeenCalled();
    expect(fs.mkdir).not.toHaveBeenCalled();
  });

  it('swallows capture errors and logs a warning — never fails the send', async () => {
    const { logger, warn } = makeFakeLogger();
    const fs = makeFakeFs({
      writeFile: vi.fn(async () => {
        throw new Error('EACCES');
      }),
    });
    const provider = createConsoleProvider(
      { ...env, EMAIL_CAPTURE_DIR: '/tmp/kiln-email' } as typeof env,
      { logger, fs },
    );

    const result = await provider.send({
      to: 'a@b.com',
      subject: 's',
      react: template(),
    });

    expect(result.status).toBe('captured');
    expect(warn).toHaveBeenCalledTimes(1);
    const [warnPayload] = warn.mock.calls[0]! as [Record<string, unknown>];
    expect(warnPayload.err).toBeInstanceOf(Error);
  });

  it('checkHealth returns static ok', async () => {
    const provider = createConsoleProvider(env);
    const health = await provider.checkHealth();
    expect(health.status).toBe('ok');
    expect(health.latencyMs).toBe(0);
  });
});

describe('redactRecipient', () => {
  it('masks a single email, preserving first 2 chars of local part + domain', () => {
    expect(redactRecipient('corey@example.com')).toBe('co***@example.com');
  });

  it('handles short local parts (1 char)', () => {
    expect(redactRecipient('a@b.com')).toBe('a***@b.com');
  });

  it('maps over arrays', () => {
    expect(redactRecipient(['alice@a.com', 'bob@b.com'])).toEqual([
      'al***@a.com',
      'bo***@b.com',
    ]);
  });

  it('passes malformed input through unchanged', () => {
    expect(redactRecipient('no-at-sign')).toBe('no-at-sign');
  });
});
