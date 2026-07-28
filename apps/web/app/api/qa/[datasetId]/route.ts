import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { webEnv } from '@/lib/config';

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
      // Forwarded so a client disconnect cancels the upstream Express request too,
      // not just this proxy's fetch; qa.ts's AbortController is otherwise unreachable.
      signal: request.signal,
    });
  } catch {
    return NextResponse.json(
      { error: { code: 'UPSTREAM_UNREACHABLE', message: 'API server unavailable' } },
      { status: 502 },
    );
  }

  let data: unknown;
  try {
    data = await upstream.json();
  } catch {
    data = { error: { code: 'UPSTREAM_ERROR', message: 'Unexpected response from server' } };
  }

  const status = !upstream.ok && upstream.status >= 500 ? 502 : upstream.status;
  return NextResponse.json(data, { status });
}
