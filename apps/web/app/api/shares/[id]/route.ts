import { type NextRequest } from 'next/server';
import { proxyDelete } from '@/lib/bff-proxy';

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  return proxyDelete(`/shares/${id}`)(request);
}
