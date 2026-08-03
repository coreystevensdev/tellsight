import { type NextRequest, NextResponse } from 'next/server';
import { webEnv } from '@/lib/config';
import { upstreamSignal } from '@/lib/bff-proxy';
import { logger } from '@/lib/logger';

const NULL_BODY_STATUSES = new Set([204, 205, 304]);

// Dynamic token in the path rules out the static-path proxyPost helper, so
// this mirrors its fetch/error shape by hand. Called from a client-side
// button click, not page render, so a link prefetch or crawler visiting the
// confirmation page can never trigger the mute as a side effect.
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  let res: Response;
  try {
    res = await fetch(`${webEnv.API_INTERNAL_URL}/alerts/mute/${encodeURIComponent(token)}`, {
      method: 'POST',
      signal: upstreamSignal(request),
    });
  } catch (err) {
    logger.warn({ err }, '[mute-route] upstream unreachable');
    return NextResponse.json(
      { error: { code: 'UPSTREAM_UNAVAILABLE', message: 'API server unreachable' } },
      { status: 502 },
    );
  }

  try {
    return NextResponse.json(await res.json(), { status: res.status });
  } catch (err) {
    logger.warn({ err }, '[mute-route] upstream returned non-JSON body');
    // A 2xx status paired with an unreadable body (including an abort mid-read)
    // is as broken as a null-body status (204/205/304) -- both mean the caller
    // can't trust res.status here, so both collapse to 502.
    const status = res.ok || NULL_BODY_STATUSES.has(res.status) ? 502 : res.status;
    return NextResponse.json(
      { error: { code: 'UPSTREAM_INVALID_RESPONSE', message: 'API server returned an invalid response' } },
      { status },
    );
  }
}
