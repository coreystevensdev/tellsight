import { type NextRequest, NextResponse } from 'next/server';
import { webEnv } from '@/lib/config';

const NULL_BODY_STATUSES = new Set([204, 205, 304]);

// Dynamic token in the path rules out the static-path proxyPost helper, so
// this mirrors its fetch/error shape by hand. Called from a client-side
// button click, not page render, so a link prefetch or crawler visiting the
// confirmation page can never trigger the unmute as a side effect.
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  let res: Response;
  try {
    res = await fetch(`${webEnv.API_INTERNAL_URL}/alerts/unmute/${encodeURIComponent(token)}`, {
      method: 'POST',
    });
  } catch (err) {
    console.warn('[unmute-route] upstream unreachable', err);
    return NextResponse.json(
      { error: { code: 'UPSTREAM_UNAVAILABLE', message: 'API server unreachable' } },
      { status: 502 },
    );
  }

  try {
    return NextResponse.json(await res.json(), { status: res.status });
  } catch (err) {
    console.warn('[unmute-route] upstream returned non-JSON body', err);
    // NextResponse.json throws if paired with a null-body status (204/205/304)
    const status = NULL_BODY_STATUSES.has(res.status) ? 502 : res.status;
    return NextResponse.json(
      { error: { code: 'UPSTREAM_INVALID_RESPONSE', message: 'API server returned an invalid response' } },
      { status },
    );
  }
}
