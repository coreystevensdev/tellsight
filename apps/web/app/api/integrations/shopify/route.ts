import { type NextRequest, NextResponse } from 'next/server';
import { webEnv } from '@/lib/config';

export async function DELETE(request: NextRequest) {
  const cookieHeader = request.headers.get('cookie') ?? '';

  try {
    const res = await fetch(`${webEnv.API_INTERNAL_URL}/integrations/shopify`, {
      method: 'DELETE',
      headers: { Cookie: cookieHeader },
    });
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch {
    return NextResponse.json(
      { error: { code: 'UPSTREAM_UNAVAILABLE', message: 'API server unreachable' } },
      { status: 502 },
    );
  }
}
