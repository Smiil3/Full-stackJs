import { randomInt } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { RESPONSE_FLOOR_JITTER_MAX_MS } from '../config/auth.js';

/**
 * Exécute `fn` puis attend qu'au moins `floorMs` (+ gigue aléatoire cryptographique de 0 à 100 ms)
 * se soient écoulées : la durée de réponse ne révèle pas quelle branche a été suivie
 * (email connu / inconnu, mail envoyé / ignoré…). Une erreur est propagée après le même plancher.
 */
export async function withResponseFloor<T>(floorMs: number, fn: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + floorMs + (floorMs > 0 ? randomInt(0, RESPONSE_FLOOR_JITTER_MAX_MS + 1) : 0);
  try {
    return await fn();
  } finally {
    const remaining = deadline - Date.now();
    if (remaining > 0) await sleep(remaining);
  }
}
