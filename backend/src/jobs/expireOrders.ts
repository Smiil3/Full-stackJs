import { TimeBudget } from '../lib/budget.js';
import { clock } from '../lib/clock.js';
import { mapLimit } from '../lib/concurrency.js';
import { withTxRetry } from '../lib/txRetry.js';
import { getDb, transaction } from '../lib/db.js';
import { getLogger } from '../lib/logger.js';
import { enqueueEmail } from '../lib/outbox.js';
import { releaseHeld } from '../modules/orders/repo.js';
import { distributeMany, lockWaitlistEntries } from '../modules/waitlist/distribute.js';
import { reconcileOrder } from './reconcilePayments.js';
import { EXPIRE_ORDERS_PER_TICK, MAX_EXPIRE_FAILURES, RECONCILE_CONCURRENCY } from '../config/worker.js';
import { RECONCILE_GRACE_MS } from '../config/payments.js';

/**
 * Expire les réservations non payées à temps et libère leurs places, UNE TRANSACTION PAR COMMANDE :
 * - `FOR UPDATE SKIP LOCKED LIMIT 1` : plusieurs workers se partagent le travail sans jamais traiter
 *   la même commande ; une commande en cours de paiement (webhook) est simplement sautée ;
 * - l'échéance est comparée à l'horloge de l'application (la même que celle qui l'a posée) ;
 * - avant d'expirer une commande carte qui a une session PSP, la session est consultée HORS transaction
 *   (rapprochement : un webhook perdu ne fait pas perdre une vente) ; PSP injoignable ⇒ expiration différée,
 *   au plus RECONCILE_GRACE_MS (un paiement ultérieur suit alors les règles du paiement tardif) ;
 * - une commande en erreur est comptée (expireFailures), journalisée et sautée : le reste du lot avance.
 * Retourne les types de places dont des places ont été libérées (pour la liste d'attente).
 */
export async function expireOrders(budget: TimeBudget = TimeBudget.unlimited()): Promise<{ expired: number; failed: number; ticketTypeIds: string[] }> {
  const released = new Set<string>();
  const skipped: string[] = [];
  let expired = 0;
  let failed = 0;
  const now = clock.now();
  const toReconcile = await getDb().$queryRaw<{ id: string; expiresAt: Date }[]>`
    SELECT o."id", o."expiresAt" FROM "orders" o
    WHERE o."status" = 'PENDING_PAYMENT' AND o."paymentMethod" = 'CARD' AND o."expiresAt" <= ${now}
      AND o."expireFailures" < ${MAX_EXPIRE_FAILURES}
      AND EXISTS (SELECT 1 FROM "psp_sessions" s WHERE s."orderId" = o."id")
    ORDER BY o."expiresAt", o."id"
    LIMIT ${EXPIRE_ORDERS_PER_TICK}`;
  // Consultations du PSP en parallèle borné (audit M3) ; une commande non consultée faute de budget n'est pas expirée.
  const { notStarted } = await mapLimit(toReconcile, RECONCILE_CONCURRENCY, async (candidate) => {
    let outcome;
    try {
      outcome = await reconcileOrder(candidate.id);
    } catch (err) {
      getLogger().error({ err, orderId: candidate.id }, 'échec du rapprochement avant expiration');
      outcome = 'unreachable' as const;
    }
    if (outcome === 'unreachable' && now.getTime() - candidate.expiresAt.getTime() < RECONCILE_GRACE_MS) skipped.push(candidate.id);
  }, () => budget.exhausted());
  for (const candidate of notStarted) skipped.push(candidate.id);
  for (let i = 0; i < EXPIRE_ORDERS_PER_TICK && !budget.exhausted(); i += 1) {
    // Objet mutable : la valeur est renseignée dans la transaction (closure).
    const current: { id: string | null } = { id: null };
    try {
      // Interblocage / conflit de sérialisation : rejoué ici avant de compter un échec (audit B2).
      const done = await withTxRetry(() => transaction(async (tx) => {
        const rows = await tx.$queryRaw<{ id: string }[]>`
          SELECT "id" FROM "orders"
          WHERE "status" IN ('PENDING_PAYMENT', 'AWAITING_TRANSFER') AND "expiresAt" <= ${now}
            AND "expireFailures" < ${MAX_EXPIRE_FAILURES}
            AND NOT ("id" = ANY(${skipped}::uuid[]))
          ORDER BY "expiresAt", "id"
          LIMIT 1
          FOR UPDATE SKIP LOCKED`;
        const id = rows[0]?.id;
        if (!id) return null;
        current.id = id;
        const { count } = await tx.order.updateMany({
          where: { id, status: { in: ['PENDING_PAYMENT', 'AWAITING_TRANSFER'] } },
          // Succès : le compteur d'échecs repart de zéro (audit B2).
          data: { status: 'EXPIRED', expireFailures: 0 },
        });
        if (count !== 1) return [];
        const order = await tx.order.findUniqueOrThrow({
          where: { id },
          include: { items: { orderBy: { ticketTypeId: 'asc' } }, user: { select: { email: true, displayName: true } }, event: { select: { title: true } } },
        });
        await lockWaitlistEntries(tx, order.items.map((i) => i.ticketTypeId));
        for (const item of order.items) await releaseHeld(tx, order.eventId, item.ticketTypeId, item.quantity);
        await enqueueEmail(tx, order.user.email, 'orderExpired', { displayName: order.user.displayName, eventTitle: order.event.title });
        // Places libérées : proposées d'abord à la liste d'attente, dans la même transaction.
        await distributeMany(tx, order.items.map((i) => i.ticketTypeId));
        return order.items.map((i) => i.ticketTypeId);
      }));
      // Comptes tenus APRÈS validation (une tentative rejouée ne compte pas deux fois).
      if (done === null) break;
      if (done.length > 0) expired += 1;
      for (const typeId of done) released.add(typeId);
    } catch (err) {
      const candidate = current.id;
      if (candidate === null) throw err;
      failed += 1;
      skipped.push(candidate);
      const { expireFailures } = await getDb().order.update({
        where: { id: candidate }, data: { expireFailures: { increment: 1 } }, select: { expireFailures: true },
      });
      const level = expireFailures >= MAX_EXPIRE_FAILURES ? 'error' : 'warn';
      getLogger()[level]({ err, orderId: candidate, expireFailures }, expireFailures >= MAX_EXPIRE_FAILURES
        ? 'commande écartée de l’expiration automatique : intervention manuelle requise'
        : 'échec d’expiration, nouvel essai au prochain passage');
    }
  }
  return { expired, failed, ticketTypeIds: [...released] };
}
