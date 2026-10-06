/**
 * Gardes de forme à l'exécution pour les réponses critiques (session, utilisateur).
 * Une réponse mal formée ne doit jamais devenir un état d'authentification.
 */
import { ApiError } from './errors';
import type { AuthSession, Membership, User } from './types';

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const ROLES = new Set(['OWNER', 'MANAGER', 'SCANNER']);

function isMembership(v: unknown): v is Membership {
  return isObj(v) && isStr(v.orgId) && isStr(v.orgName) && isStr(v.orgSlug) && typeof v.role === 'string' && ROLES.has(v.role);
}

export function isUser(v: unknown): v is User {
  return (
    isObj(v) &&
    isStr(v.id) &&
    isStr(v.email) &&
    typeof v.displayName === 'string' &&
    typeof v.emailVerified === 'boolean' &&
    typeof v.isPlatformAdmin === 'boolean' &&
    Array.isArray(v.memberships) &&
    v.memberships.every(isMembership)
  );
}

/** Durée de vie max acceptée pour un access token (le contrat annonce 10 min). */
const MAX_EXPIRES_IN = 24 * 3600;

export function isAuthSession(v: unknown): v is AuthSession {
  return (
    isObj(v) &&
    isStr(v.accessToken) &&
    !/\s/.test(v.accessToken) &&
    typeof v.expiresIn === 'number' &&
    Number.isInteger(v.expiresIn) &&
    v.expiresIn > 0 &&
    v.expiresIn <= MAX_EXPIRES_IN &&
    isUser(v.user)
  );
}

const unexpected = () => new ApiError({ status: 200, code: 'UNEXPECTED_RESPONSE', message: 'invalid shape' });

export function parseAuthSession(v: unknown): AuthSession {
  if (!isAuthSession(v)) throw unexpected();
  return v;
}

export function parseUser(v: unknown): User {
  if (!isUser(v)) throw unexpected();
  return v;
}
