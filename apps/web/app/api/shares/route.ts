import { proxyGet, proxyPost } from '@/lib/bff-proxy';

export const GET = proxyGet('/shares');
export const POST = proxyPost('/shares');
