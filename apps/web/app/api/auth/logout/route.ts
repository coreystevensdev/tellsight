import { proxyPostWithCookies } from '@/lib/bff-proxy';

export const POST = proxyPostWithCookies('/auth/logout');
