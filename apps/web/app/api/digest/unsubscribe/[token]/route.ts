import { type NextRequest, NextResponse } from 'next/server';
import { webEnv } from '@/lib/config';

const NULL_BODY_STATUSES = new Set([204, 205, 304]);

// Public, no auth. The token IS the auth. Forwards to Express which verifies
// the HMAC and flips the opt-in.
export async function POST(_req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;

  let upstream: Response;
  try {
    upstream = await fetch(
      `${webEnv.API_INTERNAL_URL}/digest/unsubscribe/${encodeURIComponent(token)}`,
      { method: 'POST' },
    );
  } catch (err) {
    console.warn('[digest-unsubscribe-route] upstream unreachable', err);
    return NextResponse.json(
      { error: { code: 'UPSTREAM_UNAVAILABLE', message: 'API server unreachable' } },
      { status: 502 },
    );
  }

  try {
    return NextResponse.json(await upstream.json(), { status: upstream.status });
  } catch (err) {
    console.warn('[digest-unsubscribe-route] upstream returned non-JSON body', err);
    // NextResponse.json throws if paired with a null-body status (204/205/304)
    const status = NULL_BODY_STATUSES.has(upstream.status) ? 502 : upstream.status;
    return NextResponse.json(
      { error: { code: 'UPSTREAM_INVALID_RESPONSE', message: 'API server returned an invalid response' } },
      { status },
    );
  }
}
