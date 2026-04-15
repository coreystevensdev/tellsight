import { type NextRequest, NextResponse } from 'next/server';
import { webEnv } from '@/lib/config';

const UPSTREAM_ERROR_RESPONSE = NextResponse.json(
  { error: { code: 'UPSTREAM_UNAVAILABLE', message: 'API server unreachable' } },
  { status: 502 },
);

function cookies(request: NextRequest): string {
  return request.headers.get('cookie') ?? '';
}

export function proxyGet(upstreamPath: string) {
  return async (request: NextRequest) => {
    try {
      const search = request.nextUrl.search;
      const res = await fetch(`${webEnv.API_INTERNAL_URL}${upstreamPath}${search}`, {
        headers: { Cookie: cookies(request) },
      });
      return NextResponse.json(await res.json(), { status: res.status });
    } catch {
      return UPSTREAM_ERROR_RESPONSE;
    }
  };
}

export function proxyPost(upstreamPath: string) {
  return async (request: NextRequest) => {
    try {
      const res = await fetch(`${webEnv.API_INTERNAL_URL}${upstreamPath}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookies(request) },
        body: await request.text(),
      });
      return NextResponse.json(await res.json(), { status: res.status });
    } catch {
      return UPSTREAM_ERROR_RESPONSE;
    }
  };
}

export function proxyPostWithCookies(upstreamPath: string) {
  return async (request: NextRequest) => {
    try {
      const res = await fetch(`${webEnv.API_INTERNAL_URL}${upstreamPath}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookies(request) },
        body: await request.text(),
      });
      const next = NextResponse.json(await res.json(), { status: res.status });
      for (const cookie of res.headers.getSetCookie()) {
        next.headers.append('Set-Cookie', cookie);
      }
      return next;
    } catch {
      return UPSTREAM_ERROR_RESPONSE;
    }
  };
}
