import { transaction } from '../lib/db.js';
import { enqueueEmail } from '../lib/outbox.js';
import { releaseHeld } from '../modules/orders/repo.js';
import { JOB_LOCKS, tryJobLock } from './lock.js';

const BATCH = 100;

/**
 * Expire les réservations non payées à temps et libère leurs places.
 * - verrou consultatif : une seule instance de worker à la fois ;
 * - `FOR UPDATE SKIP LOCKED` : une commande en cours de paiement (webhook) n'est jamais bloquée ni traitée deux fois ;
 * - transition gardée par le statut attendu, nombre de lignes vérifié.
 * Retourne les types de places dont des places ont été libérées (pour la liste d'attente).
 */
export async function expireOrders(now: Date = new Date()): Promise<{ expired: number; ticketTypeIds: string[] }> {
  return transaction(async (tx) => {
    if (!(await tryJobLock(tx, JOB_LOCKS.expireOrders))) return { expired: 0, ticketTypeIds: [] };
    const due = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "orders"
      WHERE "status" IN ('PENDING_PAYMENT', 'AWAITING_TRANSFER') AND "expiresAt" <= ${now}
      ORDER BY "expiresAt", "id"
      LIMIT ${BATCH}
      FOR UPDATE SKIP LOCKED`;
    const released = new Set<string>();
    let expired = 0;
    for (const { id } of due) {
      const { count } = await tx.order.updateMany({
        where: { id, status: { in: ['PENDING_PAYMENT', 'AWAITING_TRANSFER'] } },
        data: { status: 'EXPIRED' },
      });
      if (count !== 1) continue;
      expired += 1;
      const order = await tx.order.findUniqueOrThrow({
        where: { id },
        include: { items: { orderBy: { ticketTypeId: 'asc' } }, user: { select: { email: true, displayName: true } }, event: { select: { title: true } } },
      });
      // Types triés par id : ordre de verrouillage identique à la réservation.
      for (const item of order.items) {
        await releaseHeld(tx, item.ticketTypeId, item.quantity);
        released.add(item.ticketTypeId);
      }
      await enqueueEmail(tx, order.user.email, 'orderExpired', { displayName: order.user.displayName, eventTitle: order.event.title });
    }
    return { expired, ticketTypeIds: [...released] };
  });
}
