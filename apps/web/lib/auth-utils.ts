import { decodeJwt } from 'jose';

export function extractIsAdmin(token: string | undefined): boolean {
  if (!token) return false;
  try {
    const claims = decodeJwt(token);
    return claims.isAdmin === true;
  } catch {
    return false;
  }
}

export function extractIsOwner(token: string | undefined): boolean {
  if (!token) return false;
  try {
    const claims = decodeJwt(token);
    return claims.role === 'owner';
  } catch {
    return false;
  }
}

// The prefix test this replaced passed `/\evil.example`, which the URL parser
// resolves to https://evil.example. Compare the resolved origin, not the prefix.
// The leading-slash check stays: a bare `evil.example` resolves same-origin.
// Resolved against a fixed base rather than window.location: a candidate that
// escapes the origin escapes whatever it was resolved against, and this module
// is imported by server layouts for extractIsAdmin, where window would throw
// into the catch below and quietly send every path to the fallback.
const PROBE_ORIGIN = 'https://redirect.invalid';

export function safeRedirect(candidate: string | null | undefined): string {
  if (!candidate?.startsWith('/')) return '/dashboard';
  try {
    const url = new URL(candidate, PROBE_ORIGIN);
    if (url.origin !== PROBE_ORIGIN) return '/dashboard';
    return url.pathname + url.search + url.hash;
  } catch {
    return '/dashboard';
  }
}
