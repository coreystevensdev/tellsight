import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { webEnv } from '@/lib/config';
import { upstreamSignal } from '@/lib/bff-proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ datasetId: string }> },
) {
  const { datasetId } = await params;
  const cookie = request.headers.get('cookie') || '';

  let upstream: globalThis.Response;
  try {
    upstream = await fetch(`${webEnv.API_INTERNAL_URL}/ai-summaries/${datasetId}`, {
      headers: { cookie },
      signal: upstreamSignal(request),
    });
  } catch {
    return NextResponse.json(
      { error: { code: 'UPSTREAM_UNREACHABLE', message: 'API server unavailable' } },
      { status: 502 },
    );
  }

  if (!upstream.ok && !upstream.headers.get('content-type')?.includes('text/event-stream')) {
    const status = upstream.status >= 500 ? 502 : upstream.status;
    let data: unknown;
    try {
      data = await upstream.json();
    } catch {
      data = { error: { code: 'UPSTREAM_ERROR', message: 'Unexpected response from server' } };
    }
    return NextResponse.json(data, { status });
  }

  // SSE stream, passthrough without buffering
  if (upstream.headers.get('content-type')?.includes('text/event-stream')) {
    return new Response(upstream.body, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    });
  }

  // JSON cache hit, forward directly
  let data: unknown;
  let bodyReadFailed = false;
  try {
    data = await upstream.json();
  } catch {
    bodyReadFailed = true;
    data = { error: { code: 'UPSTREAM_ERROR', message: 'Unexpected response from server' } };
  }

  // A body-read failure (including an abort mid-read) means upstream.status is
  // stale and can't be trusted, even if it was a 2xx when headers arrived.
  return NextResponse.json(data, { status: bodyReadFailed ? 502 : upstream.status });
}
