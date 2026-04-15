import { type NextRequest } from 'next/server';
import { proxyGet } from '@/lib/bff-proxy';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  return proxyGet(`/admin/orgs/${orgId}`)(request);
}
