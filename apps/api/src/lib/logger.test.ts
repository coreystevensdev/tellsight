import { describe, it, expect, afterEach, vi } from 'vitest';

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

// Real pino, not a mock. The admin route's tests mock this module, so nothing
// there would notice if setLogLevel stopped moving the actual level.
const { logger, isLogLevel, setLogLevel } = await import('./logger.js');

const original = logger.level;
afterEach(() => {
  logger.level = original;
});

describe('isLogLevel', () => {
  it.each(['trace', 'debug', 'info', 'warn', 'error', 'fatal'])('accepts %s', (level) => {
    expect(isLogLevel(level)).toBe(true);
  });

  // 'verbose' and 'silly' are npm/winston levels. Someone will try them.
  it.each(['verbose', 'silly', 'INFO', '', null, undefined, 30, {}])('rejects %o', (value) => {
    expect(isLogLevel(value)).toBe(false);
  });
});

describe('setLogLevel', () => {
  it('moves the live level', () => {
    setLogLevel('warn');
    expect(logger.level).toBe('warn');
  });

  it('returns the level it replaced, so a caller can restore it', () => {
    setLogLevel('error');
    expect(setLogLevel('trace')).toBe('error');
  });

  it('actually suppresses a call below the new level', () => {
    setLogLevel('error');
    expect(logger.isLevelEnabled('info')).toBe(false);

    setLogLevel('debug');
    expect(logger.isLevelEnabled('info')).toBe(true);
  });

  // The whole point of the feature: the queue workers hold children built at
  // boot, and raising verbosity has to reach them or there is no reason to have
  // the route.
  it('reaches a child created before the change', () => {
    setLogLevel('error');
    const child = logger.child({ worker: 'digest' });

    setLogLevel('debug');

    expect(child.isLevelEnabled('debug')).toBe(true);
  });

  // The exception, and the reason createChildLogger must not start passing a
  // level: a child given its own level stops tracking the root for good.
  it('does not reach a child that was given its own level', () => {
    setLogLevel('info');
    const pinned = logger.child({ worker: 'noisy' }, { level: 'warn' });

    setLogLevel('debug');

    expect(pinned.isLevelEnabled('debug')).toBe(false);
  });
});
