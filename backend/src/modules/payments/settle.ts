import type { OrderStatus } from '../../generated/prisma/client.js';
import { getEnv } from '../../config/env.js';
import { writeAudit } from '../../lib/audit.js';
import { clock } from '../../lib/clock.js';
import type { Tx } from '../../lib/db.js';
import { AppError } from '../../lib/errors.js';
import { formatEuros } from '../../lib/mail/templates.js';
import { enqueueEmail } from '../../lib/outbox.js';
import { formatWithZone } from '../../lib/time.js';
import { heldToSold } from '../orders/repo.js';
import { issueTickets } from '../tickets/issue.js';

export const orderForSettlement = {
  items: { orderBy: { ticketTypeId: 'asc' } },
  user: { select: { email: true, displayName: true } },
  event: { select: { id: true, orgId: true, title: true, startsAt: true, timezone: true, status: true } },
} as const;

type SettlementOrder = NonNullable<Awaited<ReturnType<typeof loadOrderForUpdate>>>;

/** Verrouille la commande (transitions sérialisées avec l'expiration, l'annulation, un autre webhook). */
export async function loadOrderForUpdate(tx: Tx, orderId: string) {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "orders" WHERE "id" = ${orderId}::uuid FOR UPDATE`;
  if (rows.length === 0) return null;
  return tx.order.findUnique({ where: { id: orderId }, include: orderForSettlement });
}

/** Transition gardée : ne change le statut que s'il vaut encore `from` ; vérifie le nombre de lignes. */
async function transition(tx: Tx, orderId: string, from: OrderStatus[], data: { status: OrderStatus } & Record<string, unknown>): Promise<void> {
  const { count } = await tx.order.updateMany({ where: { id: orderId, status: { in: from } }, data });
  if (count !== 1) throw new AppError(409, 'INVALID_STATE', 'La commande a changé d’état entre-temps.');
}

async function confirm(tx: Tx, order: SettlementOrder): Promise<void> {
  await issueTickets(tx, order.id);
  await enqueueEmail(tx, order.user.email, 'orderConfirmed', {
    displayName: order.user.displayName,
    orderId: order.id,
    eventTitle: order.event.title,
    eventDate: formatWithZone(order.event.startsAt, order.event.timezone),
    ticketsLink: `${getEnv().frontUrl}/me/tickets`,
  });
}

/** Paiement reçu pour une commande en attente : places bloquées → vendues, billets, mail. */
export async function settleHeldOrder(tx: Tx, order: SettlementOrder, from: OrderStatus): Promise<void> {
  await transition(tx, order.id, [from], { status: 'PAID', paidAt: clock.now(), expiresAt: null });
  for (const item of order.items) await heldToSold(tx, order.eventId, item.ticketTypeId, item.quantity);
  await confirm(tx, order);
}

/**
 * Paiement arrivé APRÈS expiration : les places ont été libérées. On les reprend si elles sont encore
 * disponibles (mêmes règles qu'une réservation : capacité et priorité de la liste d'attente), sinon false.
 */
export async function tryResettleExpiredOrder(tx: Tx, order: SettlementOrder): Promise<boolean> {
  if (order.event.status !== 'PUBLISHED' || clock.now() >= order.event.startsAt) return false;
  // Types verrouillés dans l'ordre des id (même ordre que la réservation).
  for (const item of order.items) {
    const rows = await tx.$queryRaw<{ ok: boolean }[]>`
      SELECT ("sold" + "held" + ${item.quantity} <= "capacity"
              AND NOT EXISTS (SELECT 1 FROM "waitlist_entries" w WHERE w."ticketTypeId" = t."id" AND w."status" = 'WAITING')) AS ok
      FROM "ticket_types" t WHERE t."id" = ${item.ticketTypeId}::uuid AND t."eventId" = ${order.eventId}::uuid FOR UPDATE`;
    if (rows[0]?.ok !== true) return false;
  }
  for (const item of order.items) {
    const changed = await tx.$executeRaw`
      UPDATE "ticket_types" SET "sold" = "sold" + ${item.quantity}, "updatedAt" = now()
      WHERE "id" = ${item.ticketTypeId}::uuid AND "eventId" = ${order.eventId}::uuid AND "sold" + "held" + ${item.quantity} <= "capacity"`;
    if (changed !== 1) return false;
  }
  await transition(tx, order.id, ['EXPIRED'], { status: 'PAID', paidAt: clock.now(), expiresAt: null });
  await confirm(tx, order);
  return true;
}

export type RefundReason = 'LATE_PAYMENT' | 'DUPLICATE_PAYMENT' | 'SELF_CANCELLATION' | 'EVENT_CANCELLED' | 'UNEXPECTED_PAYMENT';

/**
 * Enregistre un remboursement dans la transaction métier ; il sera exécuté auprès du PSP par le worker
 * (jamais d'appel réseau ici). Paiement par virement ⇒ remboursement manuel par le collectif.
 */
export async function recordRefund(
  tx: Tx, input: { orderId: string; paymentId: string; providerPaymentId: string; amountCents: number; reason: RefundReason },
): Promise<void> {
  if (input.amountCents <= 0) return;
  const manual = input.providerPaymentId.startsWith('transfer:');
  await tx.refund.create({
    data: {
      orderId: input.orderId,
      paymentId: input.paymentId,
      amountCents: input.amountCents,
      reason: input.reason,
      status: manual ? 'MANUAL_REQUIRED' : 'PENDING',
    },
  });
}

/** Paiement en trop (commande déjà payée, expirée sans place, annulée…) : remboursement intégral de CE paiement. */
export async function refundUnexpectedPayment(
  tx: Tx, order: SettlementOrder, payment: { id: string; providerPaymentId: string; amountCents: number }, reason: RefundReason,
): Promise<void> {
  await recordRefund(tx, { orderId: order.id, paymentId: payment.id, providerPaymentId: payment.providerPaymentId, amountCents: payment.amountCents, reason });
  if (reason === 'LATE_PAYMENT' && order.status === 'EXPIRED') {
    await transition(tx, order.id, ['EXPIRED'], { status: 'REFUNDED', refundAmountCents: payment.amountCents, cancelledAt: clock.now() });
    for (const item of order.items) {
      await tx.orderItem.update({ where: { id: item.id }, data: { refundedCents: item.unitPriceCents * item.quantity } });
    }
    await enqueueEmail(tx, order.user.email, 'latePaymentRefunded', {
      displayName: order.user.displayName, eventTitle: order.event.title, amount: formatEuros(payment.amountCents),
    });
  } else {
    await enqueueEmail(tx, order.user.email, 'duplicatePaymentRefunded', {
      displayName: order.user.displayName, eventTitle: order.event.title, amount: formatEuros(payment.amountCents),
    });
  }
  await writeAudit(tx, {
    orgId: order.event.orgId, actorId: null, action: 'payment.auto_refund', target: `order:${order.id}`,
    meta: { reason, paymentId: payment.id, amountCents: payment.amountCents, orderStatus: order.status },
  });
}
