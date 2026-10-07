import { TimeBudget } from '../lib/budget.js';
import { clock } from '../lib/clock.js';
import { getDb } from '../lib/db.js';
import { getLogger } from '../lib/logger.js';
import { getPspClient, PspError } from '../lib/psp.js';
import { backoffMs } from '../lib/outbox.js';
import { MAX_REFUND_ATTEMPTS, REFUND_BATCH, REFUND_LAST_ERROR_MAX_LENGTH, REFUND_LEASE_MS, REFUND_PENDING_RECHECK_MS, TRANSIENT_PSP_STATUSES } from '../config/refunds.js';
import { HTTP_CLIENT_ERROR_MIN, HTTP_SERVER_ERROR_MIN } from '../config/http.js';

/** Erreur PSP définitive (requête refusée) : inutile de réessayer, intervention humaine. */
function isPermanent(err: unknown): boolean {
  return err instanceof PspError && err.status >= HTTP_CLIENT_ERROR_MIN && err.status < HTTP_SERVER_ERROR_MIN && !TRANSIENT_PSP_STATUSES.includes(err.status);
}

/**
 * Réponse du PSP interprétée selon son statut, jamais supposée réussie :
 * succeeded ⇒ SUCCEEDED ; pending ⇒ reste PENDING (identifiant noté, reconsulté périodiquement SANS limite d'essais :
 * le passer en traitement manuel exposerait à un double remboursement, audit B5) ; failed ou inconnu ⇒ MANUAL_REQUIRED.
 */
async function recordOutcome(
  row: { id: string; attempts: number }, result: { id: string; status: string },
): Promise<'succeeded' | 'pending' | 'manual'> {
  const db = getDb();
  if (result.status === 'succeeded') {
    await db.refund.updateMany({ where: { id: row.id, status: 'PENDING' }, data: { status: 'SUCCEEDED', providerRefundId: result.id, lastError: null } });
    return 'succeeded';
  }
  if (result.status === 'pending') {
    if (row.attempts >= MAX_REFUND_ATTEMPTS) getLogger().warn({ refundId: row.id, attempts: row.attempts }, 'remboursement toujours en cours chez le PSP : rapprochement périodique');
    await db.refund.updateMany({
      where: { id: row.id, status: 'PENDING' },
      data: { providerRefundId: result.id, nextAttemptAt: new Date(clock.now().getTime() + REFUND_PENDING_RECHECK_MS), lastError: 'PSP pending' },
    });
    return 'pending';
  }
  await db.refund.updateMany({ where: { id: row.id, status: 'PENDING' }, data: { status: 'MANUAL_REQUIRED', providerRefundId: result.id, lastError: `PSP ${result.status}`.slice(0, REFUND_LAST_ERROR_MAX_LENGTH) } });
  getLogger().error({ refundId: row.id, status: result.status }, 'remboursement refusé ou bloqué par le PSP : à traiter manuellement');
  return 'manual';
}

/**
 * Exécute les remboursements en attente auprès du PSP.
 * 1. Transaction courte : sélection `FOR UPDATE SKIP LOCKED`, bail (nextAttemptAt repoussé) et tentative
 *    comptée AVANT l'appel ⇒ un crash pendant l'appel ne fait ni double appel immédiat ni boucle infinie.
 * 2. Appels PSP HORS transaction, clé d'idempotence = id du remboursement (jamais de double remboursement).
 * 3. Échec définitif ou essais épuisés ⇒ MANUAL_REQUIRED (visible par l'organisateur), jamais un échec silencieux.
 * Chaque remboursement est isolé : une erreur (même de base de données) n'interrompt pas le lot.
 */
export async function processRefunds(budget: TimeBudget = TimeBudget.unlimited()): Promise<{ succeeded: number; manual: number }> {
  const db = getDb();
  // Une seule horloge : celle de l'application, qui pose aussi les échéances.
  const now = clock.now();
  const leased = await db.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ id: string; amountCents: number; attempts: number; providerPaymentId: string; providerRefundId: string | null }[]>`
      SELECT r."id", r."amountCents", r."attempts", p."providerPaymentId", r."providerRefundId"
      FROM "refunds" r JOIN "payments" p ON p."id" = r."paymentId"
      WHERE r."status" = 'PENDING' AND r."nextAttemptAt" <= ${now}
      ORDER BY r."nextAttemptAt", r."id"
      LIMIT ${REFUND_BATCH}
      FOR UPDATE OF r SKIP LOCKED`;
    if (rows.length > 0) {
      await tx.$executeRaw`
        UPDATE "refunds" SET "attempts" = "attempts" + 1, "nextAttemptAt" = ${new Date(now.getTime() + REFUND_LEASE_MS)}, "updatedAt" = ${now}
        WHERE "id" = ANY(${rows.map((r) => r.id)}::uuid[])`;
    }
    return rows.map((r) => ({ ...r, attempts: r.attempts + 1 }));
  });

  let succeeded = 0;
  let manual = 0;
  for (const row of leased) {
    // Budget épuisé : les remboursements non tentés seront repris à l'expiration de leur bail (5 min).
    if (budget.exhausted()) break;
    try {
      try {
        const result = await getPspClient().createRefund({ paymentId: row.providerPaymentId, amountCents: row.amountCents, idempotencyKey: row.id });
        const outcome = await recordOutcome(row, result);
        if (outcome === 'succeeded') succeeded += 1;
        if (outcome === 'manual') manual += 1;
      } catch (err) {
        const reason = err instanceof PspError ? `PSP ${err.status}` : err instanceof Error ? err.name : 'Error';
        if (!isPermanent(err) && row.attempts >= MAX_REFUND_ATTEMPTS) {
          // Essais épuisés sur erreurs réseau : la réponse a pu être perdue alors que le remboursement est fait.
          const found = await getPspClient().findRefund(row.id).catch(() => null);
          if (found) {
            const outcome = await recordOutcome(row, found);
            if (outcome === 'succeeded') succeeded += 1;
            if (outcome === 'manual') manual += 1;
            continue;
          }
        }
        if (!isPermanent(err) && row.providerRefundId !== null) {
          // Le PSP a déjà accepté ce remboursement (« pending ») : jamais de traitement manuel, on le reconsultera.
          await db.refund.updateMany({ where: { id: row.id, status: 'PENDING' }, data: { nextAttemptAt: new Date(clock.now().getTime() + REFUND_PENDING_RECHECK_MS), lastError: reason } });
          continue;
        }
        if (isPermanent(err) || row.attempts >= MAX_REFUND_ATTEMPTS) {
          await db.refund.updateMany({ where: { id: row.id, status: 'PENDING' }, data: { status: 'MANUAL_REQUIRED', lastError: reason } });
          manual += 1;
          getLogger().error({ refundId: row.id, reason, attempts: row.attempts }, 'remboursement à traiter manuellement par l’organisateur');
        } else {
          await db.refund.updateMany({ where: { id: row.id, status: 'PENDING' }, data: { nextAttemptAt: new Date(clock.now().getTime() + backoffMs(row.attempts)), lastError: reason } });
        }
      }
    } catch (err) {
      // Erreur de base de données : le bail expirera et le remboursement sera repris ; le lot continue.
      getLogger().error({ err, refundId: row.id }, 'échec de mise à jour d’un remboursement');
    }
  }
  return { succeeded, manual };
}
