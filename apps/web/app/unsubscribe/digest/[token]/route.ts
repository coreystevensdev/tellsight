import { type NextRequest, NextResponse } from 'next/server';
import { webEnv } from '@/lib/config';

const NULL_BODY_STATUSES = new Set([204, 205, 304]);

// GET must never mutate: security-gateway link scanners (Defender Safe
// Links, Proofpoint, Mimecast) prefetch email links, so this only redirects
// to the confirm page where the unsubscribe happens behind an explicit click.
export function GET(request: NextRequest) {
  return NextResponse.redirect(new URL(`${request.nextUrl.pathname}/confirm`, request.url));
}

// RFC 8058 one-click target: the List-Unsubscribe-Post header on digest
// emails points straight at this URL, so POST has to forward to Express
// itself rather than redirect like GET does.
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  let res: Response;
  try {
    res = await fetch(
      `${webEnv.API_INTERNAL_URL}/digest/unsubscribe/${encodeURIComponent(token)}`,
      { method: 'POST' },
    );
  } catch (err) {
    console.warn('[unsubscribe-bare-route] upstream unreachable', err);
    return NextResponse.json(
      { error: { code: 'UPSTREAM_UNAVAILABLE', message: 'API server unreachable' } },
      { status: 502 },
    );
  }

  try {
    return NextResponse.json(await res.json(), { status: res.status });
  } catch (err) {
    console.warn('[unsubscribe-bare-route] upstream returned non-JSON body', err);
    // NextResponse.json throws if paired with a null-body status (204/205/304)
    const status = NULL_BODY_STATUSES.has(res.status) ? 502 : res.status;
    return NextResponse.json(
      { error: { code: 'UPSTREAM_INVALID_RESPONSE', message: 'API server returned an invalid response' } },
      { status },
    );
  }
}
