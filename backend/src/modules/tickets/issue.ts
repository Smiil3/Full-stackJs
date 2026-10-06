import { randomBytes } from 'node:crypto';
import type { Tx } from '../../lib/db.js';
import { TICKET_PUBLIC_ID_BYTES } from '../../config/checkin.js';

/** publicId : 16 octets aléatoires (128 bits), base64url sans padding (22 caractères). */
export function newPublicId(): string {
  return randomBytes(TICKET_PUBLIC_ID_BYTES).toString('base64url');
}

/**
 * Émet les billets d'une commande payée. unique(orderItemId, seq) rend toute double émission
 * impossible : un second appel (webhook rejoué…) n'ajoute aucun billet.
 */
export async function issueTickets(tx: Tx, orderId: string): Promise<number> {
  const items = await tx.orderItem.findMany({ where: { orderId }, select: { id: true, quantity: true, order: { select: { eventId: true } } } });
  const data = items.flatMap((item) =>
    Array.from({ length: item.quantity }, (_, i) => ({ orderItemId: item.id, seq: i + 1, eventId: item.order.eventId, publicId: newPublicId() })),
  );
  const { count } = await tx.ticket.createMany({ data, skipDuplicates: true });
  return count;
}
