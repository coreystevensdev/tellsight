import { type NextRequest } from 'next/server';
import { proxyGet, proxyDelete } from '@/lib/bff-proxy';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  return proxyGet(`/invites/${token}`)(request);
}

// The segment is called token because the public lookup above reads one, and Next
// will not let two dynamic segments at the same level have different names. What
// arrives here is an invite id.
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token: id } = await params;
  return proxyDelete(`/invites/${id}`)(request);
}
