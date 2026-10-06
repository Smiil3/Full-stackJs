import { clock } from '../../lib/clock.js';
import { transaction, type Tx } from '../../lib/db.js';
import { AppError, errors } from '../../lib/errors.js';
import { formatEuros } from '../../lib/mail/templates.js';
import { allocate, floorPercentOf } from '../../lib/money.js';
import { enqueueEmail } from '../../lib/outbox.js';
import { getLogger } from '../../lib/logger.js';
import { loadOrderForUpdate, recordRefund, type RefundReason } from '../payments/settle.js';
import { distributeMany, lockWaitlistEntries } from '../waitlist/distribute.js';
import { canSelfCancelPaid, eventCancellationRefund, selfCancellationRefund } from './refund.js';
import { releaseHeld } from './repo.js';
import { viewOwnOrder } from './service.js';
import { HTTP_STATUS } from '../../config/http.js';

type LockedOrder = NonNullable<Awaited<ReturnType<typeof loadOrderForUpdate>>>;

async function usedTickets(tx: Tx, orderId: string): Promise<number> {
  return tx.ticket.count({ where: { orderItem: { orderId }, status: 'USED' } });
}

/** Commande non payée annulée : places bloquées libérées (et proposées à la liste d'attente). */
async function cancelUnpaid(tx: Tx, order: LockedOrder, distribute: boolean): Promise<void> {
  const { count } = await tx.order.updateMany({
    where: { id: order.id, status: { in: ['PENDING_PAYMENT', 'AWAITING_TRANSFER'] } },
    data: { status: 'CANCELLED', cancelledAt: clock.now(), refundAmountCents: 0 },
  });
  if (count !== 1) throw errors.state('INVALID_STATE', 'La commande a changé d’état entre-temps.');
  await lockWaitlistEntries(tx, order.items.map((i) => i.ticketTypeId));
  for (const item of order.items) await releaseHeld(tx, order.eventId, item.ticketTypeId, item.quantity);
  if (distribute) await distributeMany(tx, order.items.map((i) => i.ticketTypeId));
}

/**
 * Commande payée annulée (self-service ou annulation d'événement) : billets annulés (transition gardée :
 * un billet scanné entre-temps fait échouer l'opération), places vendues rendues, remboursement enregistré
 * (exécuté par le worker), parts remboursées réparties sur les lignes, statut REFUNDED.
 * `subtotalPart` = part remboursée hors frais (répartie par ligne), `total` = montant total remboursé.
 */
async function refundPaid(
  tx: Tx, order: LockedOrder, input: { total: number; subtotalPart: number; reason: RefundReason; cancelUsedTickets: boolean; distribute: boolean },
): Promise<{ refunded: number; manual: boolean }> {
  const tickets = await tx.ticket.count({ where: { orderItem: { orderId: order.id } } });
  const { count: cancelled } = await tx.ticket.updateMany({
    where: { orderItem: { orderId: order.id }, status: input.cancelUsedTickets ? { in: ['VALID', 'USED'] } : 'VALID' },
    data: { status: 'CANCELLED', usedAt: null },
  });
  if (cancelled !== tickets) throw errors.state('CANCELLATION_CLOSED', 'Un billet de cette commande a déjà été utilisé.');
  const shares = allocate(input.subtotalPart, order.items.map((i) => i.unitPriceCents * i.quantity));
  if (input.distribute) await lockWaitlistEntries(tx, order.items.map((i) => i.ticketTypeId));
  for (const [i, item] of order.items.entries()) {
    await tx.orderItem.update({ where: { id: item.id }, data: { refundedCents: shares[i] ?? 0 } });
    const changed = await tx.$executeRaw`
      UPDATE "ticket_types" SET "sold" = "sold" - ${item.quantity}, "updatedAt" = ${clock.now()}
      WHERE "id" = ${item.ticketTypeId}::uuid AND "eventId" = ${order.eventId}::uuid AND "sold" >= ${item.quantity}`;
    if (changed !== 1) throw new AppError(HTTP_STATUS.INTERNAL_SERVER_ERROR, 'INTERNAL_ERROR', 'Incohérence de stock lors de l’annulation.');
  }
  let remaining = input.total;
  let manual = false;
  const payments = await tx.payment.findMany({ where: { orderId: order.id, status: 'SUCCEEDED' }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
  for (const payment of payments) {
    if (remaining <= 0) break;
    const recorded = await recordRefund(tx, { orderId: order.id, paymentId: payment.id, providerPaymentId: payment.providerPaymentId, amountCents: remaining, reason: input.reason });
    if (recorded > 0 && payment.providerPaymentId.startsWith('transfer:')) manual = true;
    remaining -= recorded;
  }
  // Montant RÉELLEMENT remboursé (après plafonnement au reste remboursable de chaque paiement).
  const refunded = input.total - remaining;
  if (remaining > 0) getLogger().warn({ orderId: order.id, expected: input.total, refunded }, 'remboursement plafonné : montant attendu supérieur au remboursable');
  const { count } = await tx.order.updateMany({
    where: { id: order.id, status: 'PAID' },
    data: { status: 'REFUNDED', refundAmountCents: refunded, cancelledAt: clock.now() },
  });
  if (count !== 1) throw errors.state('INVALID_STATE', 'La commande a changé d’état entre-temps.');
  if (input.distribute) await distributeMany(tx, order.items.map((i) => i.ticketTypeId));
  return { refunded, manual };
}

/**
 * Annulation par l'acheteur. Non payée ⇒ CANCELLED. Payée ⇒ REFUNDED si l'annulation self-service est
 * possible (même règle et MÊME fonction de calcul que `refundPreviewCents`), sinon CANCELLATION_CLOSED.
 */
export async function cancelOwnOrder(userId: string, orderId: string) {
  await transaction(async (tx) => {
    const owned = await tx.order.findFirst({ where: { id: orderId, userId }, select: { id: true } });
    if (!owned) throw errors.notFound();
    const order = await loadOrderForUpdate(tx, orderId);
    if (!order) throw errors.notFound();
    if (order.status === 'PENDING_PAYMENT' || order.status === 'AWAITING_TRANSFER') {
      await cancelUnpaid(tx, order, true);
      return;
    }
    if (order.status !== 'PAID') throw errors.state('INVALID_STATE', 'Cette commande ne peut plus être annulée.');
    // Événement annulé : le remboursement intégral est en cours de traitement par le collectif.
    if (order.event.status === 'CANCELLED') throw errors.state('CANCELLATION_CLOSED', 'L’événement est annulé : votre remboursement intégral est en cours.');
    const state = { status: order.status, cancellableUntil: order.cancellableUntil, eventStartsAt: order.event.startsAt, scannedTickets: await usedTickets(tx, order.id) };
    if (!canSelfCancelPaid(state, clock.now())) {
      throw errors.state('CANCELLATION_CLOSED', 'L’annulation n’est plus possible pour cette commande.');
    }
    const total = selfCancellationRefund(order);
    const subtotalPart = floorPercentOf(order.subtotalCents, order.refundPercent);
    const result = await refundPaid(tx, order, { total, subtotalPart, reason: 'SELF_CANCELLATION', cancelUsedTickets: false, distribute: true });
    await enqueueEmail(tx, order.user.email, 'orderRefunded', {
      displayName: order.user.displayName, eventTitle: order.event.title, amount: formatEuros(result.refunded),
      reason: 'annulation à votre demande', transferRefundPending: result.manual,
    });
  });
  return transaction((tx) => viewOwnOrder(tx, userId, orderId));
}

/** Annulation d'événement : chaque commande payée est remboursée intégralement (frais compris), les autres annulées. */
export async function cancelOrderForEvent(tx: Tx, orderId: string, reason: string): Promise<void> {
  const order = await loadOrderForUpdate(tx, orderId);
  if (!order) return;
  if (order.status === 'PENDING_PAYMENT' || order.status === 'AWAITING_TRANSFER') {
    await cancelUnpaid(tx, order, false);
    await enqueueEmail(tx, order.user.email, 'eventCancelled', { displayName: order.user.displayName, eventTitle: order.event.title, reason, amount: null, transferRefundPending: false });
  } else if (order.status === 'PAID') {
    const total = eventCancellationRefund(order);
    const result = await refundPaid(tx, order, { total, subtotalPart: order.subtotalCents, reason: 'EVENT_CANCELLED', cancelUsedTickets: true, distribute: false });
    await enqueueEmail(tx, order.user.email, 'eventCancelled', {
      displayName: order.user.displayName, eventTitle: order.event.title, reason, amount: formatEuros(result.refunded), transferRefundPending: result.manual,
    });
  }
}
