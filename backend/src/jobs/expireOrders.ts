import { getDb, transaction } from '../lib/db.js';
import { getLogger } from '../lib/logger.js';
import { enqueueEmail } from '../lib/outbox.js';
import { releaseHeld } from '../modules/orders/repo.js';
import { distributeMany } from '../modules/waitlist/distribute.js';

/** Commandes traitées au plus par passage du worker. */
const MAX_PER_TICK = 200;
/** Au-delà de ce nombre d'échecs, la commande est écartée (alerte) pour ne pas bloquer les suivantes. */
export const MAX_EXPIRE_FAILURES = 5;

/**
 * Expire les réservations non payées à temps et libère leurs places, UNE TRANSACTION PAR COMMANDE :
 * - `FOR UPDATE SKIP LOCKED LIMIT 1` : plusieurs workers se partagent le travail sans jamais traiter
 *   la même commande ; une commande en cours de paiement (webhook) est simplement sautée ;
 * - l'échéance est comparée à `now()` de la base (une seule horloge de référence) ;
 * - une commande en erreur est comptée (expireFailures), journalisée et sautée : le reste du lot avance.
 * Retourne les types de places dont des places ont été libérées (pour la liste d'attente).
 */
export async function expireOrders(): Promise<{ expired: number; failed: number; ticketTypeIds: string[] }> {
  const released = new Set<string>();
  const skipped: string[] = [];
  let expired = 0;
  let failed = 0;
  for (let i = 0; i < MAX_PER_TICK; i += 1) {
    // Objet mutable : la valeur est renseignée dans la transaction (closure).
    const current: { id: string | null } = { id: null };
    try {
      const done = await transaction(async (tx) => {
        const rows = await tx.$queryRaw<{ id: string }[]>`
          SELECT "id" FROM "orders"
          WHERE "status" IN ('PENDING_PAYMENT', 'AWAITING_TRANSFER') AND "expiresAt" <= now()
            AND "expireFailures" < ${MAX_EXPIRE_FAILURES}
            AND NOT ("id" = ANY(${skipped}::uuid[]))
          ORDER BY "expiresAt", "id"
          LIMIT 1
          FOR UPDATE SKIP LOCKED`;
        const id = rows[0]?.id;
        if (!id) return false;
        current.id = id;
        const { count } = await tx.order.updateMany({
          where: { id, status: { in: ['PENDING_PAYMENT', 'AWAITING_TRANSFER'] } },
          data: { status: 'EXPIRED' },
        });
        if (count !== 1) return true;
        const order = await tx.order.findUniqueOrThrow({
          where: { id },
          include: { items: { orderBy: { ticketTypeId: 'asc' } }, user: { select: { email: true, displayName: true } }, event: { select: { title: true } } },
        });
        for (const item of order.items) await releaseHeld(tx, order.eventId, item.ticketTypeId, item.quantity);
        await enqueueEmail(tx, order.user.email, 'orderExpired', { displayName: order.user.displayName, eventTitle: order.event.title });
        // Places libérées : proposées d'abord à la liste d'attente, dans la même transaction.
        await distributeMany(tx, order.items.map((i) => i.ticketTypeId));
        for (const item of order.items) released.add(item.ticketTypeId);
        expired += 1;
        return true;
      });
      if (!done) break;
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
