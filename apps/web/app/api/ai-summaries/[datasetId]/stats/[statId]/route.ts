import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { webEnv } from '@/lib/config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ datasetId: string; statId: string }> },
) {
  const { datasetId, statId } = await params;
  const cookie = request.headers.get('cookie') || '';

  // Next decodes the path segment into `statId` (so a category containing
  // `/` comes through with a literal slash), re-encode before forwarding or
  // the upstream request line would split into extra segments.
  let upstream: globalThis.Response;
  try {
    upstream = await fetch(
      `${webEnv.API_INTERNAL_URL}/ai-summaries/${datasetId}/stats/${encodeURIComponent(statId)}`,
      { headers: { cookie } },
    );
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

  const status = upstream.status >= 500 ? 502 : upstream.status;
  return NextResponse.json(data, { status });
}
