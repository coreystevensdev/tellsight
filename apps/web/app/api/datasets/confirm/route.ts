import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { webEnv } from '@/lib/config';

export const runtime = 'nodejs';

/**
 * BFF proxy for dataset confirmation. Re-sends the original CSV file
 * to Express for re-parsing + persistence. Same streaming pattern as
 * the upload proxy, multipart body forwarded without buffering.
 */
export async function POST(request: NextRequest) {
  const contentType = request.headers.get('content-type') || '';
  const cookie = request.headers.get('cookie') || '';

  const response = await fetch(`${webEnv.API_INTERNAL_URL}/datasets/confirm`, {
    method: 'POST',
    headers: {
      'content-type': contentType,
      cookie,
    },
    body: request.body,
    duplex: 'half',
  } as RequestInit);

  let data: unknown;
  try {
    data = await response.json();
  } catch {
    data = { error: { code: 'UPSTREAM_ERROR', message: 'Unexpected response from the server. Please try again.' } };
  }

  const status = response.status >= 500 ? 502 : response.status;
  const nextResponse = NextResponse.json(data, { status });

  for (const setCookie of response.headers.getSetCookie()) {
    nextResponse.headers.append('Set-Cookie', setCookie);
  }

  return nextResponse;
}
