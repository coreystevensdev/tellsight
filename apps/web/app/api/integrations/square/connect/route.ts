import { proxyPostWithCookies } from '@/lib/bff-proxy';

// Forwards Set-Cookie because /connect hands back the square_oauth_nonce cookie
// the callback compares against its server-side binding. The nonce is the only
// thing in it; the org and user live in Redis, where the browser cannot reach
// them. Plain proxyPost drops the cookie and every callback then fails the
// nonce check.
export const POST = proxyPostWithCookies('/integrations/square/connect');
