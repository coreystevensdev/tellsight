import { type NextRequest } from 'next/server';
import { proxyGet } from '@/lib/bff-proxy';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  return proxyGet(`/invites/${token}`)(request);
}
