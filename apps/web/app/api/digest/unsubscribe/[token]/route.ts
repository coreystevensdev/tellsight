import { type NextRequest, NextResponse } from 'next/server';
import { webEnv } from '@/lib/config';
import { upstreamSignal } from '@/lib/bff-proxy';
import { logger } from '@/lib/logger';

const NULL_BODY_STATUSES = new Set([204, 205, 304]);

// Public, no auth. The token IS the auth. Forwards to Express which verifies
// the HMAC and flips the opt-in.
export async function POST(req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;

  let upstream: Response;
  try {
    upstream = await fetch(
      `${webEnv.API_INTERNAL_URL}/digest/unsubscribe/${encodeURIComponent(token)}`,
      { method: 'POST', signal: upstreamSignal(req) },
    );
  } catch (err) {
    logger.warn({ err }, '[digest-unsubscribe-route] upstream unreachable');
    return NextResponse.json(
      { error: { code: 'UPSTREAM_UNAVAILABLE', message: 'API server unreachable' } },
      { status: 502 },
    );
  }

  try {
    return NextResponse.json(await upstream.json(), { status: upstream.status });
  } catch (err) {
    logger.warn({ err }, '[digest-unsubscribe-route] upstream returned non-JSON body');
    // A 2xx status paired with an unreadable body (including an abort mid-read)
    // is as broken as a null-body status (204/205/304) -- both mean the caller
    // can't trust upstream.status here, so both collapse to 502.
    const status = upstream.ok || NULL_BODY_STATUSES.has(upstream.status) ? 502 : upstream.status;
    return NextResponse.json(
      { error: { code: 'UPSTREAM_INVALID_RESPONSE', message: 'API server returned an invalid response' } },
      { status },
    );
  }
}
