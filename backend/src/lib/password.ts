import argon2 from 'argon2';
import { randomToken } from './crypto.js';
import { Semaphore } from './semaphore.js';
import { normalizePassword } from './passwordPolicy.js';
import { ARGON2_MAX_CONCURRENT, ARGON2_MAX_QUEUE, ARGON2_MEMORY_KIB, ARGON2_PARALLELISM, ARGON2_TIME_COST } from '../config/password.js';

/** Paramètres épinglés (recommandation OWASP, voir config/password.ts). */
export const ARGON2_PARAMS = { type: argon2.argon2id, memoryCost: ARGON2_MEMORY_KIB, timeCost: ARGON2_TIME_COST, parallelism: ARGON2_PARALLELISM } as const;

/** Calculs argon2 simultanés bornés, file bornée ; au-delà 429. */
export const argon2Semaphore = new Semaphore(ARGON2_MAX_CONCURRENT, ARGON2_MAX_QUEUE);

/** Compteurs d'observabilité (tests) : nombre réel de hashs et de vérifications. */
export const passwordMetrics = { hashes: 0, verifications: 0 };

/** Hash argon2id du mot de passe normalisé NFC. */
export function hashPassword(password: string): Promise<string> {
  return argon2Semaphore.run(() => {
    passwordMetrics.hashes += 1;
    return argon2.hash(normalizePassword(password), ARGON2_PARAMS);
  });
}

export function verifyPasswordHash(hash: string, password: string): Promise<boolean> {
  return argon2Semaphore.run(async () => {
    passwordMetrics.verifications += 1;
    try {
      return await argon2.verify(hash, normalizePassword(password));
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
    const pending = argon2.hash(randomToken(), ARGON2_PARAMS);
    dummyHash = pending;
    pending.catch(() => {
      if (dummyHash === pending) dummyHash = null;
    });
  }
  return dummyHash;
}
