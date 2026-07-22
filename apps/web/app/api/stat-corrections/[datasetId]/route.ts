import { type NextRequest, NextResponse } from 'next/server';
import { webEnv } from '@/lib/config';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ datasetId: string }> },
) {
  const { datasetId } = await params;
  const cookie = request.headers.get('cookie') || '';

  try {
    const res = await fetch(
      `${webEnv.API_INTERNAL_URL}/stat-corrections/${encodeURIComponent(datasetId)}`,
      { headers: { cookie } },
    );
    return NextResponse.json(await res.json(), { status: res.status });
  } catch {
    return NextResponse.json(
      { error: { code: 'UPSTREAM_UNAVAILABLE', message: 'API server unreachable' } },
      { status: 502 },
    );
  }
}
