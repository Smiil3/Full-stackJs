import { getDb } from '../lib/db.js';
import { getLogger } from '../lib/logger.js';
import { getPspClient } from '../lib/psp.js';
import { backoffMs } from '../lib/outbox.js';

const BATCH = 20;
const LEASE_MS = 5 * 60_000;
const MAX_ATTEMPTS = 10;

/**
 * Exécute les remboursements en attente auprès du PSP.
 * 1. Transaction courte : sélection `FOR UPDATE SKIP LOCKED` + bail (nextAttemptAt repoussé) ⇒ aucun autre worker ne les prend.
 * 2. Appels PSP HORS transaction, avec clé d'idempotence = id du remboursement (jamais de double remboursement).
 * 3. Mise à jour gardée par le statut PENDING.
 */
export async function processRefunds(): Promise<{ succeeded: number; failed: number }> {
  const db = getDb();
  const leased = await db.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ id: string; amountCents: number; attempts: number; providerPaymentId: string }[]>`
      SELECT r."id", r."amountCents", r."attempts", p."providerPaymentId"
      FROM "refunds" r JOIN "payments" p ON p."id" = r."paymentId"
      -- Tolérance de 2 s : échéance posée par l'application, comparée à l'horloge de la base.
      WHERE r."status" = 'PENDING' AND r."nextAttemptAt" <= now() + interval '2 seconds'
      ORDER BY r."nextAttemptAt", r."id"
      LIMIT ${BATCH}
      FOR UPDATE OF r SKIP LOCKED`;
    if (rows.length > 0) {
      await tx.refund.updateMany({ where: { id: { in: rows.map((r) => r.id) } }, data: { nextAttemptAt: new Date(Date.now() + LEASE_MS) } });
    }
    return rows;
  });

  let succeeded = 0;
  let failed = 0;
  for (const row of leased) {
    try {
      const result = await getPspClient().createRefund({ paymentId: row.providerPaymentId, amountCents: row.amountCents, idempotencyKey: row.id });
      await db.refund.updateMany({
        where: { id: row.id, status: 'PENDING' },
        data: { status: 'SUCCEEDED', providerRefundId: result.id, attempts: row.attempts + 1, lastError: null },
      });
      succeeded += 1;
    } catch (err) {
      const attempts = row.attempts + 1;
      const terminal = attempts >= MAX_ATTEMPTS;
      await db.refund.updateMany({
        where: { id: row.id, status: 'PENDING' },
        data: terminal
          ? { status: 'FAILED', attempts, lastError: err instanceof Error ? err.name : 'Error' }
          : { attempts, nextAttemptAt: new Date(Date.now() + backoffMs(attempts)), lastError: err instanceof Error ? err.name : 'Error' },
      });
      if (terminal) {
        failed += 1;
        getLogger().error({ refundId: row.id }, 'remboursement abandonné après plusieurs échecs : intervention manuelle requise');
      }
    }
  }
  return { succeeded, failed };
}
