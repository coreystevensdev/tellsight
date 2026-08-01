import { type NextRequest } from 'next/server';
import { proxyPatch } from '@/lib/bff-proxy';

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  return proxyPatch(`/proposals/${id}`)(request);
}
