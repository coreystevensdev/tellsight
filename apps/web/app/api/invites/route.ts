import { proxyGet, proxyPost } from '@/lib/bff-proxy';

export const GET = proxyGet('/invites');
export const POST = proxyPost('/invites');
