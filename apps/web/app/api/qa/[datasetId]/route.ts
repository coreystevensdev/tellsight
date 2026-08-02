import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { webEnv } from '@/lib/config';
import { upstreamSignal } from '@/lib/bff-proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ datasetId: string }> },
) {
  const { datasetId } = await params;
  const cookie = request.headers.get('cookie') || '';
  const body = await request.text();

  let upstream: globalThis.Response;
  try {
    upstream = await fetch(`${webEnv.API_INTERNAL_URL}/qa/${encodeURIComponent(datasetId)}`, {
      method: 'POST',
      headers: { cookie, 'Content-Type': 'application/json' },
      body,
      // Forwards the client's disconnect (qa.ts's AbortController is otherwise
      // unreachable) and adds a timeout backstop for a hung Claude call.
      signal: upstreamSignal(request),
    });
  } catch (err) {
    console.warn('[qa-route] upstream unreachable', err);
    return NextResponse.json(
      { error: { code: 'UPSTREAM_UNREACHABLE', message: 'API server unavailable' } },
      { status: 502 },
    );
  }

  let data: unknown;
  let bodyReadFailed = false;
  try {
    data = await upstream.json();
  } catch (err) {
    console.warn('[qa-route] upstream returned non-JSON body', err);
    bodyReadFailed = true;
    data = { error: { code: 'UPSTREAM_ERROR', message: 'Unexpected response from server' } };
  }

  // A body-read failure (including an abort mid-read) means upstream.status is
  // stale and can't be trusted, even if it was a 2xx when headers arrived.
  const status = bodyReadFailed || (!upstream.ok && upstream.status >= 500) ? 502 : upstream.status;
  return NextResponse.json(data, { status });
}
