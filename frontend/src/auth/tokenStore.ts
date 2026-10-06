/**
 * Access token : MÉMOIRE UNIQUEMENT (closure de module).
 * Jamais localStorage / sessionStorage / IndexedDB / cookie lisible : un rechargement de page
 * perd le token, la session est restaurée via le cookie HttpOnly de refresh (POST /auth/refresh).
 */
let accessToken: string | null = null;
/** Horodatage (ms) d'expiration annoncé par le serveur. */
let expiresAtMs = 0;

export function getAccessToken(): string | null {
  return accessToken;
}

export function getAccessTokenExpiry(): number {
  return expiresAtMs;
}

export function setAccessToken(token: string, expiresInSeconds: number, now: number = Date.now()): void {
  accessToken = token;
  expiresAtMs = now + Math.max(0, expiresInSeconds) * 1000;
}

export function clearAccessToken(): void {
  accessToken = null;
  expiresAtMs = 0;
}
