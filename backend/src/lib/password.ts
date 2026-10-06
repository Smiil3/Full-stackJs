import argon2 from 'argon2';
import { randomToken } from './crypto.js';
import { Semaphore } from './semaphore.js';

/** Paramètres épinglés (recommandation OWASP) : argon2id, 19 Mio, 2 itérations, parallélisme 1. */
export const ARGON2_PARAMS = { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

/** Au plus 4 calculs argon2 simultanés, 64 en file ; au-delà 429. */
export const argon2Semaphore = new Semaphore(4, 64);

/** Compteurs d'observabilité (tests) : nombre réel de hashs et de vérifications. */
export const passwordMetrics = { hashes: 0, verifications: 0 };

export function hashPassword(password: string): Promise<string> {
  return argon2Semaphore.run(() => {
    passwordMetrics.hashes += 1;
    return argon2.hash(password, ARGON2_PARAMS);
  });
}

export function verifyPasswordHash(hash: string, password: string): Promise<boolean> {
  return argon2Semaphore.run(async () => {
    passwordMetrics.verifications += 1;
    try {
      return await argon2.verify(hash, password);
    } catch {
      return false;
    }
  });
}

let dummyHash: Promise<string> | null = null;
/**
 * Hash factice : un email inconnu coûte le même temps de calcul qu'un email connu (anti-énumération
 * par timing). Calculé au démarrage ; une promesse en échec n'est jamais gardée en cache.
 */
export function getDummyHash(): Promise<string> {
  if (!dummyHash) {
    const pending = argon2.hash(randomToken(32), ARGON2_PARAMS);
    dummyHash = pending;
    pending.catch(() => {
      if (dummyHash === pending) dummyHash = null;
    });
  }
  return dummyHash;
}
