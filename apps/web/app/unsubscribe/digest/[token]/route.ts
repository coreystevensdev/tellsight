import { type NextRequest, NextResponse } from 'next/server';
import { webEnv } from '@/lib/config';

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
  try {
    const res = await fetch(
      `${webEnv.API_INTERNAL_URL}/digest/unsubscribe/${encodeURIComponent(token)}`,
      { method: 'POST' },
    );
    return NextResponse.json(await res.json(), { status: res.status });
  } catch {
    return NextResponse.json(
      { error: { code: 'UPSTREAM_UNAVAILABLE', message: 'API server unreachable' } },
      { status: 502 },
    );
  }
}
