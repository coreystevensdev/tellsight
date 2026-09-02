import { describe, it, expect, vi, beforeEach } from 'vitest';

// auth.test.ts exercises both session cookies end to end, but its parseCookies
// helper splits the Set-Cookie header and keeps only name=value, so every
// attribute is discarded before anything is asserted. Setting secure to false
// and sameSite to 'none' left the whole API suite green, which in production
// ships both session cookies over plaintext HTTP and drops the SameSite barrier
// on an API authenticated entirely by cookie.
//
// The one incidental attribute assertion in the repo is on qb_oauth_state's
// httpOnly, which is why flipping httpOnly does fail and these two did not.

const env = { NODE_ENV: 'development', COOKIE_DOMAIN: undefined as string | undefined };
vi.mock('../config.js', () => ({ env }));

// isProduction is read once at module load, so each environment needs a fresh
// module registry rather than just a different env value.
async function cookiesWith(overrides: Partial<typeof env>) {
  Object.assign(env, { NODE_ENV: 'development', COOKIE_DOMAIN: undefined }, overrides);
  vi.resetModules();
  return import('./cookies.js');
}

beforeEach(() => {
  vi.resetModules();
});

describe('sessionCookieOptions', () => {
  it('is httpOnly, lax and root-scoped', async () => {
    const { sessionCookieOptions } = await cookiesWith({});
    const opts = sessionCookieOptions(900);

    expect(opts.httpOnly).toBe(true);
    expect(opts.sameSite).toBe('lax');
    expect(opts.path).toBe('/');
  });

  // 'none' would let any site's fetch carry the session; 'strict' would break
  // the OAuth redirect back from Google. 'lax' is the only correct answer here,
  // so this pins the exact value rather than merely "not none".
  it('pins sameSite to lax exactly', async () => {
    const { sessionCookieOptions, clearCookieOptions } = await cookiesWith({});

    expect(sessionCookieOptions(900).sameSite).toBe('lax');
    expect(clearCookieOptions().sameSite).toBe('lax');
  });

  it('sets secure in production', async () => {
    const { sessionCookieOptions, clearCookieOptions } = await cookiesWith({ NODE_ENV: 'production' });

    expect(sessionCookieOptions(900).secure).toBe(true);
    expect(clearCookieOptions().secure).toBe(true);
  });

  // Local docker-compose is plain HTTP, so a secure cookie there would never be
  // sent back and every login would silently fail to stick.
  it('does not set secure outside production', async () => {
    const { sessionCookieOptions } = await cookiesWith({ NODE_ENV: 'development' });

    expect(sessionCookieOptions(900).secure).toBe(false);
  });

  it('converts the max age from seconds to milliseconds', async () => {
    const { sessionCookieOptions } = await cookiesWith({});

    expect(sessionCookieOptions(900).maxAge).toBe(900_000);
    expect(sessionCookieOptions(60 * 60 * 24 * 30).maxAge).toBe(2_592_000_000);
  });

  it('omits the domain directive unless COOKIE_DOMAIN is set', async () => {
    const { sessionCookieOptions } = await cookiesWith({});

    expect(sessionCookieOptions(900)).not.toHaveProperty('domain');
  });

  it('sets the domain directive when COOKIE_DOMAIN is set', async () => {
    const { sessionCookieOptions, clearCookieOptions } = await cookiesWith({
      COOKIE_DOMAIN: '.tellsight.app',
    });

    expect(sessionCookieOptions(900).domain).toBe('.tellsight.app');
    expect(clearCookieOptions().domain).toBe('.tellsight.app');
  });
});

describe('clearCookieOptions', () => {
  // Express matches the cookie to delete on name plus these attributes, so a
  // clear whose flags drift from the ones used to set it silently leaves the
  // session cookie in the browser.
  it('matches sessionCookieOptions on every attribute except maxAge', async () => {
    const { sessionCookieOptions, clearCookieOptions } = await cookiesWith({
      NODE_ENV: 'production',
      COOKIE_DOMAIN: '.tellsight.app',
    });

    const { maxAge, ...session } = sessionCookieOptions(900);

    expect(maxAge).toBe(900_000);
    expect(clearCookieOptions()).toEqual(session);
  });
});
