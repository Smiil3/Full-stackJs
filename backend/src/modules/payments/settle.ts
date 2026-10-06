import type { OrderStatus } from '../../generated/prisma/client.js';
import { getEnv } from '../../config/env.js';
import { writeAudit } from '../../lib/audit.js';
import { clock } from '../../lib/clock.js';
import type { Tx } from '../../lib/db.js';
import { AppError } from '../../lib/errors.js';
import { getLogger } from '../../lib/logger.js';
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

/**
 * Paiement reçu pour une commande en attente : places bloquées → vendues, billets, mail.
 * Les types sont verrouillés et le stock bloqué vérifié AVANT toute écriture : en cas d'incohérence,
 * rien n'est modifié et false est renvoyé (l'appelant rembourse et alerte au lieu d'échouer en boucle).
 */
export async function settleHeldOrder(tx: Tx, order: SettlementOrder, from: OrderStatus): Promise<boolean> {
  for (const item of order.items) {
    const rows = await tx.$queryRaw<{ held: number }[]>`
      SELECT "held" FROM "ticket_types" WHERE "id" = ${item.ticketTypeId}::uuid AND "eventId" = ${order.eventId}::uuid FOR UPDATE`;
    if ((rows[0]?.held ?? -1) < item.quantity) return false;
  }
  await transition(tx, order.id, [from], { status: 'PAID', paidAt: clock.now(), expiresAt: null });
  for (const item of order.items) await heldToSold(tx, order.eventId, item.ticketTypeId, item.quantity);
  await confirm(tx, order);
  return true;
}

/**
 * Paiement arrivé APRÈS expiration : les places ont été libérées. On les reprend si elles sont encore
 * disponibles (mêmes règles qu'une réservation : capacité et priorité de la liste d'attente), sinon false.
 */
export async function tryResettleExpiredOrder(tx: Tx, order: SettlementOrder): Promise<boolean> {
  // Seule une commande carte peut être « rattrapée » par un paiement carte tardif.
  if (order.paymentMethod !== 'CARD' || order.event.status !== 'PUBLISHED' || clock.now() >= order.event.startsAt) return false;
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
 * Le paiement est verrouillé et le cumul vérifié AVANT insertion (le déclencheur SQL reste le filet ultime) :
 * le montant est plafonné au reste remboursable, jamais d'exception qui ferait perdre l'événement.
 */
export async function recordRefund(
  tx: Tx, input: { orderId: string | null; paymentId: string; providerPaymentId: string; amountCents: number; reason: RefundReason },
): Promise<number> {
  const rows = await tx.$queryRaw<{ amountCents: number; refunded: number }[]>`
    SELECT p."amountCents",
           COALESCE((SELECT SUM(r."amountCents") FROM "refunds" r WHERE r."paymentId" = p."id" AND r."status" <> 'FAILED'), 0)::int AS refunded
    FROM "payments" p WHERE p."id" = ${input.paymentId}::uuid FOR UPDATE`;
  const payment = rows[0];
  if (!payment) throw new Error('Paiement introuvable pour le remboursement');
  const amount = Math.min(input.amountCents, payment.amountCents - payment.refunded);
  if (amount < input.amountCents) {
    getLogger().error({ paymentId: input.paymentId, requested: input.amountCents, remaining: amount }, 'remboursement plafonné au reste remboursable');
  }
  if (amount <= 0) return 0;
  const manual = input.providerPaymentId.startsWith('transfer:');
  await tx.refund.create({
    data: {
      orderId: input.orderId,
      paymentId: input.paymentId,
      amountCents: amount,
      reason: input.reason,
      status: manual ? 'MANUAL_REQUIRED' : 'PENDING',
    },
  });
  return amount;
}

interface ReceivedPayment {
  id: string;
  providerPaymentId: string;
  amountCents: number;
}

/**
 * Somme encaissée qui ne donnera pas de billets : remboursement intégral automatique + log error + audit
 * (+ mail si l'acheteur est connu). `order` peut être null (commande inconnue).
 */
export async function refundUnexpectedPayment(
  tx: Tx, order: SettlementOrder | null, payment: ReceivedPayment, reason: RefundReason, detail: string,
): Promise<void> {
  const amount = await recordRefund(tx, { orderId: order?.id ?? null, paymentId: payment.id, providerPaymentId: payment.providerPaymentId, amountCents: payment.amountCents, reason });
  getLogger().error({ orderId: order?.id ?? null, paymentId: payment.id, reason, detail }, 'paiement encaissé sans billets : remboursement automatique');
  if (order) {
    if (reason === 'LATE_PAYMENT' && order.status === 'EXPIRED') {
      await transition(tx, order.id, ['EXPIRED'], { status: 'REFUNDED', refundAmountCents: amount, cancelledAt: clock.now() });
      for (const item of order.items) {
        await tx.orderItem.update({ where: { id: item.id }, data: { refundedCents: item.unitPriceCents * item.quantity } });
      }
    }
    const template = reason === 'LATE_PAYMENT' ? 'latePaymentRefunded' : reason === 'DUPLICATE_PAYMENT' ? 'duplicatePaymentRefunded' : 'unexpectedPaymentRefunded';
    await enqueueEmail(tx, order.user.email, template, {
      displayName: order.user.displayName, eventTitle: order.event.title, amount: formatEuros(amount),
    });
  }
  await writeAudit(tx, {
    orgId: order?.event.orgId ?? null, actorId: null, action: 'payment.auto_refund', target: order ? `order:${order.id}` : `payment:${payment.id}`,
    meta: { reason, detail, paymentId: payment.id, amountCents: amount, orderStatus: order?.status ?? null },
  });
}
