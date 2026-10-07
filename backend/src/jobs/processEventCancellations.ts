import { transaction } from '../lib/db.js';
import { getLogger } from '../lib/logger.js';
import { withTxRetry } from '../lib/txRetry.js';
import { cancelOrderForEvent } from '../modules/orders/cancel.js';
import { EVENT_CANCELLATIONS_PER_TICK } from '../config/worker.js';
import { TimeBudget } from '../lib/budget.js';

/**
 * Traite les commandes des événements annulés, UNE TRANSACTION PAR COMMANDE (`FOR UPDATE SKIP LOCKED`) :
 * payées ⇒ remboursées intégralement, en attente ⇒ annulées, billets annulés, mails. Idempotent et repris
 * au passage suivant ; une commande en erreur est journalisée et sautée pour ce passage.
 */
export async function processEventCancellations(budget: TimeBudget = TimeBudget.unlimited()): Promise<{ processed: number; failed: number }> {
  let processed = 0;
  let failed = 0;
  const skipped: string[] = [];
  for (let i = 0; i < EVENT_CANCELLATIONS_PER_TICK && !budget.exhausted(); i += 1) {
    const current: { id: string | null } = { id: null };
    try {
      const done = await withTxRetry(() => transaction(async (tx) => {
        const rows = await tx.$queryRaw<{ id: string; reason: string | null }[]>`
          SELECT o."id", e."cancelReason" AS reason
          FROM "orders" o JOIN "events" e ON e."id" = o."eventId"
          WHERE e."status" = 'CANCELLED' AND o."status" IN ('PENDING_PAYMENT', 'AWAITING_TRANSFER', 'PAID')
            AND NOT (o."id" = ANY(${skipped}::uuid[]))
          ORDER BY o."id"
          LIMIT 1
          FOR UPDATE OF o SKIP LOCKED`;
        const row = rows[0];
        if (!row) return false;
        current.id = row.id;
        await cancelOrderForEvent(tx, row.id, row.reason ?? 'événement annulé');
        return true;
      }));
      if (!done) break;
      processed += 1;
    } catch (err) {
      const id = current.id;
      if (id === null) throw err;
      skipped.push(id);
      failed += 1;
      getLogger().error({ err, orderId: id }, 'échec du traitement d’une commande d’événement annulé (repris au prochain passage)');
    }
  }
  return { processed, failed };
}
