import type { RequestHandler, Response } from 'express';
import { getDb } from '../lib/db.js';
import { errors } from '../lib/errors.js';
import { verifyAccessToken } from '../lib/jwt.js';

export interface AuthContext {
  userId: string;
  email: string;
  emailVerified: boolean;
  isPlatformAdmin: boolean;
}

const BEARER = /^Bearer ([A-Za-z0-9_-]{1,2048}\.[A-Za-z0-9_-]{1,4096}\.[A-Za-z0-9_-]{1,1024})$/;

/**
 * Authentifie la requête par access token puis relit l'utilisateur EN BASE :
 * compte supprimé ou version de jeton périmée (changement de mot de passe) ⇒ 401.
 */
export const requireAuth: RequestHandler = async (req, res, next) => {
  const header = req.headers.authorization;
  const match = typeof header === 'string' ? BEARER.exec(header) : null;
  const token = match?.[1];
  if (!token) throw errors.unauthenticated();
  const claims = await verifyAccessToken(token);
  if (!claims) throw errors.unauthenticated();
  const user = await getDb().user.findUnique({
    where: { id: claims.userId },
    select: { id: true, email: true, emailVerifiedAt: true, isPlatformAdmin: true, tokenVersion: true },
  });
  // Version stricte : tout jeton émis avant un changement / reset de mot de passe est refusé, même dans la même seconde.
  if (!user || claims.tokenVersion !== user.tokenVersion) throw errors.unauthenticated();
  res.locals['auth'] = {
    userId: user.id,
    email: user.email,
    emailVerified: user.emailVerifiedAt !== null,
    isPlatformAdmin: user.isPlatformAdmin,
  } satisfies AuthContext;
  next();
};

export function getAuth(res: Response): AuthContext {
  const auth = res.locals['auth'] as AuthContext | undefined;
  if (!auth) throw errors.unauthenticated();
  return auth;
}

export const requireVerifiedEmail: RequestHandler = (_req, res, next) => {
  if (!getAuth(res).emailVerified) throw errors.emailNotVerified();
  next();
};

/** Administration plateforme : un non-admin reçoit 404 (l'existence de la route n'est pas révélée). */
export const requirePlatformAdmin: RequestHandler = (_req, res, next) => {
  if (!getAuth(res).isPlatformAdmin) throw errors.notFound();
  next();
};
