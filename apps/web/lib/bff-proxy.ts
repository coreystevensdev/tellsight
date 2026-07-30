import { type NextRequest, NextResponse } from 'next/server';
import { webEnv } from '@/lib/config';

const UPSTREAM_ERROR_RESPONSE = NextResponse.json(
  { error: { code: 'UPSTREAM_UNAVAILABLE', message: 'API server unreachable' } },
  { status: 502 },
);

// The qa route's tool-use loop has no wall-clock cap of its own (only a turn
// count and cost ceiling), so this needs enough headroom for a legitimate
// multi-turn answer, not just a fast JSON round trip.
export const UPSTREAM_TIMEOUT_MS = 60_000;

// Races the client's own disconnect against a hang backstop so a stuck
// Express instance still resolves to the existing 502 path instead of
// hanging forever.
export function upstreamSignal(request: NextRequest): AbortSignal {
  return AbortSignal.any([request.signal, AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)]);
}

function cookies(request: NextRequest): string {
  return request.headers.get('cookie') ?? '';
}

export function proxyGet(upstreamPath: string) {
  return async (request: NextRequest) => {
    try {
      const search = request.nextUrl.search;
      const res = await fetch(`${webEnv.API_INTERNAL_URL}${upstreamPath}${search}`, {
        headers: { Cookie: cookies(request) },
        signal: upstreamSignal(request),
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
        signal: upstreamSignal(request),
      });
      return NextResponse.json(await res.json(), { status: res.status });
    } catch {
      return UPSTREAM_ERROR_RESPONSE;
    }
  };
}

export function proxyPut(upstreamPath: string) {
  return async (request: NextRequest) => {
    try {
      const res = await fetch(`${webEnv.API_INTERNAL_URL}${upstreamPath}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Cookie: cookies(request) },
        body: await request.text(),
        signal: upstreamSignal(request),
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
        signal: upstreamSignal(request),
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
