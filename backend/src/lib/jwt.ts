import { randomUUID } from 'node:crypto';
import { SignJWT, jwtVerify, type JWTHeaderParameters } from 'jose';
import { getEnv } from '../config/env.js';
import { ACCESS_TOKEN_TTL_SECONDS } from '../config/auth.js';

const ALGORITHM = 'HS256';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;


/**
 * Access token : payload minimal (`sub`, `jti`, `ver` + claims standard), aucun rôle ni donnée personnelle.
 * `ver` = User.tokenVersion au moment de l'émission ; comparé strictement à chaque requête.
 */
export async function signAccessToken(userId: string, tokenVersion: number): Promise<string> {
  const env = getEnv();
  const { current } = env.jwtKeyring;
  return new SignJWT({ ver: tokenVersion })
    .setProtectedHeader({ alg: ALGORITHM, typ: 'JWT', kid: current.id })
    .setSubject(userId)
    .setJti(randomUUID())
    .setIssuedAt()
    .setIssuer(env.jwtIssuer)
    .setAudience(env.jwtAudience)
    .setExpirationTime(`${ACCESS_TOKEN_TTL_SECONDS}s`)
    .sign(current.key);
}

export interface AccessClaims {
  userId: string;
  tokenVersion: number;
}

/**
 * Vérifie un access token : algorithme épinglé (refuse `none`, RS256…), signature, `iss`, `aud`, `exp`.
 * Retourne null pour tout jeton invalide (la cause n'est jamais exposée au client).
 */
export async function verifyAccessToken(token: string): Promise<AccessClaims | null> {
  const env = getEnv();
  try {
    // Clé choisie par le `kid` de l'en-tête, uniquement dans le trousseau (kid absent ou inconnu ⇒ refus).
    const resolveKey = (header: JWTHeaderParameters): Uint8Array => {
      const k = typeof header.kid === 'string' ? env.jwtKeyring.byId.get(header.kid) : undefined;
      if (!k) throw new Error('kid inconnu');
      return k;
    };
    const { payload } = await jwtVerify(token, resolveKey, {
      algorithms: [ALGORITHM],
      issuer: env.jwtIssuer,
      audience: env.jwtAudience,
      requiredClaims: ['sub', 'jti', 'iat', 'exp', 'ver'],
      clockTolerance: 5,
    });
    const ver = payload['ver'];
    if (typeof payload.sub !== 'string' || !UUID_RE.test(payload.sub) || typeof ver !== 'number' || !Number.isSafeInteger(ver) || ver < 0) {
      return null;
    }
    return { userId: payload.sub, tokenVersion: ver };
  } catch {
    return null;
  }
}
