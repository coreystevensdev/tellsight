import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { webEnv } from '@/lib/config';
import { forwardedFor } from '@/lib/bff-proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const cookie = request.headers.get('cookie') || '';

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: { code: 'INVALID_BODY', message: 'Invalid JSON body' } },
      { status: 400 },
    );
  }

  try {
    const upstream = await fetch(`${webEnv.API_INTERNAL_URL}/analytics/events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        cookie,
        ...forwardedFor(request),
      },
      body: JSON.stringify(body),
    });

    if (!upstream.ok) {
      const status = upstream.status >= 500 ? 502 : upstream.status;
      let data: unknown;
      try {
        data = await upstream.json();
      } catch {
        data = { error: { code: 'UPSTREAM_ERROR', message: 'Unexpected response from server' } };
      }
      return NextResponse.json(data, { status });
    }

    return NextResponse.json({ data: { ok: true } });
  } catch {
    return NextResponse.json(
      { error: { code: 'UPSTREAM_UNREACHABLE', message: 'API server unavailable' } },
      { status: 502 },
    );
  }
}
