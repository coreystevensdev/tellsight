import { type NextRequest, NextResponse } from 'next/server';
import { webEnv } from '@/lib/config';

// Public, no auth. The token IS the auth. Forwards to Express which verifies
// the HMAC and flips the opt-in.
export async function POST(_req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;

  try {
    const upstream = await fetch(
      `${webEnv.API_INTERNAL_URL}/digest/unsubscribe/${encodeURIComponent(token)}`,
      { method: 'POST' },
    );
    return NextResponse.json(await upstream.json(), { status: upstream.status });
  } catch {
    return NextResponse.json(
      { error: { code: 'UPSTREAM_UNAVAILABLE', message: 'API server unreachable' } },
      { status: 502 },
    );
  }
}
