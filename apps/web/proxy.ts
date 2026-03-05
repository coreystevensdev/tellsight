import { NextRequest, NextResponse } from 'next/server';
import { jwtVerify } from 'jose';
import { webEnv } from '@/lib/config';

const PROTECTED_ROUTES = ['/upload', '/billing', '/admin', '/settings'];

function getJwtSecret(): Uint8Array | null {
  if (!webEnv.JWT_SECRET) return null;
  return new TextEncoder().encode(webEnv.JWT_SECRET);
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  const isProtected = PROTECTED_ROUTES.some(
    (route) => pathname === route || pathname.startsWith(`${route}/`),
  );

  if (isProtected) {
    const token = request.cookies.get('access_token')?.value;

    if (!token) {
      const loginUrl = new URL('/login', request.url);
      loginUrl.searchParams.set('redirect', pathname);
      return NextResponse.redirect(loginUrl);
    }

    const secret = getJwtSecret();
    if (secret) {
      try {
        await jwtVerify(token, secret);
      } catch {
        const loginUrl = new URL('/login', request.url);
        loginUrl.searchParams.set('redirect', pathname);
        return NextResponse.redirect(loginUrl);
      }
    } else if (webEnv.NODE_ENV === 'production') {
      // JWT_SECRET must be set in production — never skip verification
      return new NextResponse('Server configuration error', { status: 500 });
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/upload/:path*', '/billing/:path*', '/admin/:path*', '/settings/:path*'],
};
