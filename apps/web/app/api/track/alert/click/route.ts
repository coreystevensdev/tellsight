import { proxyPost } from '@/lib/bff-proxy';

// Public Express endpoint, but the BFF proxy still forwards cookies, harmless
// here and keeps the call shape uniform with the rest of the app's APIs.
export const POST = proxyPost('/track/alert/click');
