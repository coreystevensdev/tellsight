import { type NextRequest, NextResponse } from 'next/server';
import { proxyGet } from '@/lib/bff-proxy';
import { webEnv } from '@/lib/config';

export async function POST(request: NextRequest) {
  const cookieHeader = request.headers.get('cookie') ?? '';
  const body = await request.text();

  const url = new URL(request.url);
  const action = url.searchParams.get('action') ?? 'checkout';
  const endpoint = action === 'portal' ? '/subscriptions/portal' : '/subscriptions/checkout';

  const response = await fetch(`${webEnv.API_INTERNAL_URL}${endpoint}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: cookieHeader,
    },
    body,
  });

  const data = await response.json();
  return NextResponse.json(data, { status: response.status });
}

export const GET = proxyGet('/subscriptions/tier');
