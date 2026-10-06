import { getDb } from '../lib/db.js';
import { getLogger } from '../lib/logger.js';
import { getPspClient, PspError } from '../lib/psp.js';
import { backoffMs } from '../lib/outbox.js';

const BATCH = 20;
const LEASE_MS = 5 * 60_000;
export const MAX_REFUND_ATTEMPTS = 10;

/** Erreur PSP définitive (requête refusée) : inutile de réessayer, intervention humaine. */
function isPermanent(err: unknown): boolean {
  return err instanceof PspError && err.status >= 400 && err.status < 500 && ![408, 409, 425, 429].includes(err.status);
}

/**
 * Exécute les remboursements en attente auprès du PSP.
 * 1. Transaction courte : sélection `FOR UPDATE SKIP LOCKED`, bail (nextAttemptAt repoussé) et tentative
 *    comptée AVANT l'appel ⇒ un crash pendant l'appel ne fait ni double appel immédiat ni boucle infinie.
 * 2. Appels PSP HORS transaction, clé d'idempotence = id du remboursement (jamais de double remboursement).
 * 3. Échec définitif ou essais épuisés ⇒ MANUAL_REQUIRED (visible par l'organisateur), jamais un échec silencieux.
 * Chaque remboursement est isolé : une erreur (même de base de données) n'interrompt pas le lot.
 */
export async function processRefunds(): Promise<{ succeeded: number; manual: number }> {
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
      await tx.$executeRaw`
        UPDATE "refunds" SET "attempts" = "attempts" + 1, "nextAttemptAt" = now() + make_interval(secs => ${LEASE_MS / 1000}), "updatedAt" = now()
        WHERE "id" = ANY(${rows.map((r) => r.id)}::uuid[])`;
    }
    return rows.map((r) => ({ ...r, attempts: r.attempts + 1 }));
  });

  let succeeded = 0;
  let manual = 0;
  for (const row of leased) {
    try {
      try {
        const result = await getPspClient().createRefund({ paymentId: row.providerPaymentId, amountCents: row.amountCents, idempotencyKey: row.id });
        await db.refund.updateMany({
          where: { id: row.id, status: 'PENDING' },
          data: { status: 'SUCCEEDED', providerRefundId: result.id, lastError: null },
        });
        succeeded += 1;
      } catch (err) {
        const reason = err instanceof PspError ? `PSP ${err.status}` : err instanceof Error ? err.name : 'Error';
        if (isPermanent(err) || row.attempts >= MAX_REFUND_ATTEMPTS) {
          await db.refund.updateMany({ where: { id: row.id, status: 'PENDING' }, data: { status: 'MANUAL_REQUIRED', lastError: reason } });
          manual += 1;
          getLogger().error({ refundId: row.id, reason, attempts: row.attempts }, 'remboursement à traiter manuellement par l’organisateur');
        } else {
          await db.refund.updateMany({ where: { id: row.id, status: 'PENDING' }, data: { nextAttemptAt: new Date(Date.now() + backoffMs(row.attempts)), lastError: reason } });
        }
      }
    } catch (err) {
      // Erreur de base de données : le bail expirera et le remboursement sera repris ; le lot continue.
      getLogger().error({ err, refundId: row.id }, 'échec de mise à jour d’un remboursement');
    }
  }
  return { succeeded, manual };
}
