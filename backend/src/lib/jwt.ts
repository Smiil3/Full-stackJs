import { randomUUID } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import { getEnv } from '../config/env.js';

export const ACCESS_TOKEN_TTL_SECONDS = 600;
const ALGORITHM = 'HS256';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function key(): Uint8Array {
  return new TextEncoder().encode(getEnv().jwtAccessSecret);
}

/** Access token : payload minimal (`sub`, `jti` + claims standard), aucun rôle ni donnée personnelle. */
export async function signAccessToken(userId: string): Promise<string> {
  const env = getEnv();
  return new SignJWT({})
    .setProtectedHeader({ alg: ALGORITHM, typ: 'JWT' })
    .setSubject(userId)
    .setJti(randomUUID())
    .setIssuedAt()
    .setIssuer(env.jwtIssuer)
    .setAudience(env.jwtAudience)
    .setExpirationTime(`${ACCESS_TOKEN_TTL_SECONDS}s`)
    .sign(key());
}

export interface AccessClaims {
  userId: string;
  issuedAt: number;
}

/**
 * Vérifie un access token : algorithme épinglé (refuse `none`, RS256…), signature, `iss`, `aud`, `exp`.
 * Retourne null pour tout jeton invalide (la cause n'est jamais exposée au client).
 */
export async function verifyAccessToken(token: string): Promise<AccessClaims | null> {
  const env = getEnv();
  try {
    const { payload } = await jwtVerify(token, key(), {
      algorithms: [ALGORITHM],
      issuer: env.jwtIssuer,
      audience: env.jwtAudience,
      requiredClaims: ['sub', 'jti', 'iat', 'exp'],
      clockTolerance: 5,
    });
    if (typeof payload.sub !== 'string' || !UUID_RE.test(payload.sub) || typeof payload.iat !== 'number') return null;
    return { userId: payload.sub, issuedAt: payload.iat };
  } catch {
    return null;
  }
}
