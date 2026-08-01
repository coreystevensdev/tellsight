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
