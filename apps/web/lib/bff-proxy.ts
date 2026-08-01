import { type NextRequest, NextResponse } from 'next/server';
import { webEnv } from '@/lib/config';

const UPSTREAM_ERROR_RESPONSE = NextResponse.json(
  { error: { code: 'UPSTREAM_UNAVAILABLE', message: 'API server unreachable' } },
  { status: 502 },
);

const NULL_BODY_STATUSES = new Set([204, 205, 304]);

// A 2xx status paired with an unreadable body is as broken as a null-body
// status (204/205/304) -- both mean res.status can't be trusted here, so
// both collapse to 502 instead of passing a stale/invalid status through.
function invalidResponse(res: Response) {
  const status = res.ok || NULL_BODY_STATUSES.has(res.status) ? 502 : res.status;
  return NextResponse.json(
    { error: { code: 'UPSTREAM_INVALID_RESPONSE', message: 'API server returned an invalid response' } },
    { status },
  );
}

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
    let res: Response;
    try {
      const search = request.nextUrl.search;
      res = await fetch(`${webEnv.API_INTERNAL_URL}${upstreamPath}${search}`, {
        headers: { Cookie: cookies(request) },
        signal: upstreamSignal(request),
      });
    } catch {
      return UPSTREAM_ERROR_RESPONSE;
    }

    try {
      return NextResponse.json(await res.json(), { status: res.status });
    } catch {
      return invalidResponse(res);
    }
  };
}

export function proxyPost(upstreamPath: string) {
  return async (request: NextRequest) => {
    let res: Response;
    try {
      res = await fetch(`${webEnv.API_INTERNAL_URL}${upstreamPath}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookies(request) },
        body: await request.text(),
        signal: upstreamSignal(request),
      });
    } catch {
      return UPSTREAM_ERROR_RESPONSE;
    }

    try {
      return NextResponse.json(await res.json(), { status: res.status });
    } catch {
      return invalidResponse(res);
    }
  };
}

export function proxyPut(upstreamPath: string) {
  return async (request: NextRequest) => {
    let res: Response;
    try {
      res = await fetch(`${webEnv.API_INTERNAL_URL}${upstreamPath}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Cookie: cookies(request) },
        body: await request.text(),
        signal: upstreamSignal(request),
      });
    } catch {
      return UPSTREAM_ERROR_RESPONSE;
    }

    try {
      return NextResponse.json(await res.json(), { status: res.status });
    } catch {
      return invalidResponse(res);
    }
  };
}

export function proxyPatch(upstreamPath: string) {
  return async (request: NextRequest) => {
    let res: Response;
    try {
      res = await fetch(`${webEnv.API_INTERNAL_URL}${upstreamPath}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: cookies(request) },
        body: await request.text(),
        signal: upstreamSignal(request),
      });
    } catch {
      return UPSTREAM_ERROR_RESPONSE;
    }

    try {
      return NextResponse.json(await res.json(), { status: res.status });
    } catch {
      return invalidResponse(res);
    }
  };
}

export function proxyPostWithCookies(upstreamPath: string) {
  return async (request: NextRequest) => {
    let res: Response;
    try {
      res = await fetch(`${webEnv.API_INTERNAL_URL}${upstreamPath}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookies(request) },
        body: await request.text(),
        signal: upstreamSignal(request),
      });
    } catch {
      return UPSTREAM_ERROR_RESPONSE;
    }

    try {
      const next = NextResponse.json(await res.json(), { status: res.status });
      for (const cookie of res.headers.getSetCookie()) {
        next.headers.append('Set-Cookie', cookie);
      }
      return next;
    } catch {
      return invalidResponse(res);
    }
  };
}
