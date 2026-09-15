import { proxyPostWithCookies } from '@/lib/bff-proxy';

// Must forward Set-Cookie: /connect hands back the OAuth state cookie the
// callback checks against. Plain proxyPost drops them, which breaks the flow
// at the callback with nothing to show for it.
export const POST = proxyPostWithCookies('/integrations/square/connect');
