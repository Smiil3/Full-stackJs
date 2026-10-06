import { setTimeout as sleep } from 'node:timers/promises';
import { randomInt } from 'node:crypto';
import { AppError } from './errors.js';
import { ERROR_CAUSE_MAX_DEPTH, TX_RETRY_ATTEMPTS, TX_RETRY_JITTER_MAX_MS, TX_RETRY_JITTER_MIN_MS } from '../config/database.js';
import { HTTP_STATUS } from '../config/http.js';

const RETRYABLE_SQLSTATES = new Set(['40P01', '40001']);

/**
 * Interblocage (40P01), échec de sérialisation (40001) ou conflit d'écriture Prisma (P2034) :
 * erreurs TRANSITOIRES, on peut rejouer la transaction entière. Le code peut se trouver sur l'erreur,
 * ses métadonnées ou sa cause selon la couche (Prisma, adaptateur pg).
 */
export function isTransientTxError(err: unknown, depth = 0): boolean {
  if (typeof err !== 'object' || err === null || depth > ERROR_CAUSE_MAX_DEPTH) return false;
  const e = err as { code?: unknown; meta?: Record<string, unknown>; cause?: unknown; message?: unknown };
  if (e.code === 'P2034' || (typeof e.code === 'string' && RETRYABLE_SQLSTATES.has(e.code))) return true;
  for (const key of ['code', 'originalCode', 'driverAdapterError']) {
    const v = e.meta?.[key];
    if (typeof v === 'string' && RETRYABLE_SQLSTATES.has(v)) return true;
    if (typeof v === 'object' && isTransientTxError(v, depth + 1)) return true;
  }
  if (typeof e.message === 'string' && /deadlock detected|could not serialize access/i.test(e.message)) return true;
  return isTransientTxError(e.cause, depth + 1);
}

/** Rejoue `fn` (TX_RETRY_ATTEMPTS essais, petite gigue aléatoire) sur erreur transitoire, puis 409 CONFLICT propre. */
export async function withTxRetry<T>(fn: () => Promise<T>, alsoRetry: (err: unknown) => boolean = () => false, attempts = TX_RETRY_ATTEMPTS): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      if (!isTransientTxError(err) && !alsoRetry(err)) throw err;
      if (attempt >= attempts) throw new AppError(HTTP_STATUS.CONFLICT, 'CONFLICT', 'Conflit d’accès concurrent, veuillez réessayer.');
      await sleep(randomInt(TX_RETRY_JITTER_MIN_MS, TX_RETRY_JITTER_MAX_MS) * attempt);
    }
  }
}
