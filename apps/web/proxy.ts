import { NextRequest, NextResponse } from 'next/server';
import { decodeJwt, jwtVerify } from 'jose';
import { webEnv } from '@/lib/config';

const PROTECTED_ROUTES = ['/upload', '/billing', '/admin', '/settings'];

// /dashboard is public and must never redirect, but it renders org-scoped data
// server-side, so it still needs a live access token whenever one can be minted.
// Without it an expired access cookie makes a signed-in owner anonymous and the
// charts route serves the seed org's numbers instead of theirs.
const SESSION_ROUTES = [...PROTECTED_ROUTES, '/dashboard'];

const ACCESS_TOKEN = 'access_token';
const REFRESH_TOKEN = 'refresh_token';

let jwtSecretWarned = false;

function getJwtSecret(): Uint8Array | null {
  if (!webEnv.JWT_SECRET) {
    if (!jwtSecretWarned && webEnv.NODE_ENV !== 'production') {
      jwtSecretWarned = true;
      console.warn('[proxy] JWT_SECRET not set, protected route verification skipped in dev');
    }
    return null;
  }
  return new TextEncoder().encode(webEnv.JWT_SECRET);
}

function isAdminRoute(pathname: string) {
  return pathname === '/admin' || pathname.startsWith('/admin/');
}

function matches(pathname: string, routes: string[]) {
  return routes.some((route) => pathname === route || pathname.startsWith(`${route}/`));
}

// Prefetches fire on hover and on viewport entry. Rotating the refresh token for
// a page the user may never open would hand the rotated cookie to a request whose
// response the router can discard, and two prefetches in flight at once present
// the same token twice, which the API reads as reuse and answers by revoking
// every session the user has.
function isPrefetch(request: NextRequest) {
  return (
    request.headers.get('next-router-prefetch') === '1' ||
    request.headers.get('purpose') === 'prefetch'
  );
}

function nameValue(setCookie: string): [string, string] | null {
  const [pair] = setCookie.split(';', 1);
  if (!pair) return null;
  const eq = pair.indexOf('=');
  if (eq < 1) return null;
  return [pair.slice(0, eq).trim(), pair.slice(eq + 1).trim()];
}

async function isUsable(token: string | undefined, secret: Uint8Array | null) {
  if (!token) return false;

  if (secret) {
    try {
      await jwtVerify(token, secret);
      return true;
    } catch {
      // Expired, tampered with, or signed under a rotated-out secret. Minting
      // fixes all three, so they do not need telling apart here.
      return false;
    }
  }

  // No secret is a local-dev state: production returns 500 below rather than
  // reaching this, and CI sets one. Authenticity is unanswerable without it and
  // the guard below falls back to presence for that. Expiry is a different
  // question and does not need the secret, so read it instead of calling a dead
  // token good and rendering a signed-in owner as anonymous. This decides only
  // whether to ask for a fresher token; the refresh itself is authenticated by
  // the refresh cookie, which the API validates.
  try {
    const { exp } = decodeJwt(token);
    return exp === undefined || exp * 1000 > Date.now();
  } catch {
    return false;
  }
}

// Returns the API's own Set-Cookie lines rather than parsed values, so httpOnly,
// secure, sameSite, domain and max-age stay whatever the API decided. Restating
// them here would be a second source of truth that drifts from apps/api/src/lib/cookies.ts.
async function mintSession(request: NextRequest): Promise<string[] | null> {
  const refreshToken = request.cookies.get(REFRESH_TOKEN)?.value;
  if (!refreshToken) return null;

  try {
    const res = await fetch(`${webEnv.API_INTERNAL_URL}/auth/refresh`, {
      method: 'POST',
      headers: { cookie: `${REFRESH_TOKEN}=${refreshToken}` },
    });
    if (!res.ok) return null;
    const cookies = res.headers.getSetCookie();
    return cookies.length > 0 ? cookies : null;
  } catch {
    // API unreachable. Fall through signed out rather than failing the render.
    return null;
  }
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const isProtected = matches(pathname, PROTECTED_ROUTES);
  const secret = getJwtSecret();

  let token = request.cookies.get(ACCESS_TOKEN)?.value;
  let minted: string[] | null = null;

  if (matches(pathname, SESSION_ROUTES) && !isPrefetch(request) && !(await isUsable(token, secret))) {
    minted = await mintSession(request);
    if (minted) {
      for (const line of minted) {
        const pair = nameValue(line);
        if (pair) request.cookies.set(pair[0], pair[1]);
      }
      token = request.cookies.get(ACCESS_TOKEN)?.value;
    }
  }

  // Every exit runs through here. A mint that rotated the refresh token in the
  // database without returning the new cookie leaves the browser holding a
  // revoked one, and presenting that is what trips reuse detection.
  const finish = (response: NextResponse) => {
    if (minted) {
      for (const line of minted) response.headers.append('set-cookie', line);
    }
    return response;
  };

  const toLogin = () => {
    const loginUrl = new URL('/login', request.url);
    loginUrl.searchParams.set('redirect', pathname);
    return finish(NextResponse.redirect(loginUrl));
  };

  if (isProtected) {
    if (!token) {
      return toLogin();
    }

    if (secret) {
      try {
        const { payload } = await jwtVerify(token, secret);

        if (isAdminRoute(pathname) && !payload.isAdmin) {
          return finish(NextResponse.redirect(new URL('/dashboard', request.url)));
        }
      } catch {
        return toLogin();
      }
    } else if (webEnv.NODE_ENV === 'production') {
      return finish(new NextResponse('Server configuration error', { status: 500 }));
    }
  }

  return finish(minted ? NextResponse.next({ request }) : NextResponse.next());
}

export const config = {
  matcher: [
    '/upload/:path*',
    '/billing/:path*',
    '/admin/:path*',
    '/settings/:path*',
    '/dashboard/:path*',
  ],
};
