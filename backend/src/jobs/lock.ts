import type { Tx } from '../lib/db.js';

/** Identifiants des verrous consultatifs des jobs (une seule instance exécute un job à un instant donné). */
export const JOB_LOCKS = {
  expireOrders: 7_001,
  expireWaitlistOffers: 7_002,
  processRefunds: 7_003,
  distributeWaitlist: 7_004,
} as const;

/** Verrou consultatif transactionnel non bloquant : false si une autre instance exécute déjà le job. */
export async function tryJobLock(tx: Tx, key: number): Promise<boolean> {
  const rows = await tx.$queryRaw<{ locked: boolean }[]>`SELECT pg_try_advisory_xact_lock(${key}::bigint) AS locked`;
  return rows[0]?.locked === true;
}
