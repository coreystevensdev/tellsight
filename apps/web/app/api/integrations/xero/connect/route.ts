import { proxyPostWithCookies } from '@/lib/bff-proxy';

// Forwards Set-Cookie because /connect hands back the xero_oauth_nonce cookie
// the callback compares against its server-side binding. Plain proxyPost drops
// it and every callback then fails the nonce check.
export const POST = proxyPostWithCookies('/integrations/xero/connect');
