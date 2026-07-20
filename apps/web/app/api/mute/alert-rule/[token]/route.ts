import { type NextRequest, NextResponse } from 'next/server';
import { webEnv } from '@/lib/config';

// Dynamic token in the path rules out the static-path proxyPost helper, so
// this mirrors its fetch/error shape by hand. Called from a client-side
// button click, not page render, so a link prefetch or crawler visiting the
// confirmation page can never trigger the mute as a side effect.
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  try {
    const res = await fetch(`${webEnv.API_INTERNAL_URL}/alerts/mute/${encodeURIComponent(token)}`, {
      method: 'POST',
    });
    return NextResponse.json(await res.json(), { status: res.status });
  } catch {
    return NextResponse.json(
      { error: { code: 'UPSTREAM_UNAVAILABLE', message: 'API server unreachable' } },
      { status: 502 },
    );
  }
}
