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
import { alreadyOwned, heldToSold, lockBuyerEvent, releaseHeld } from '../orders/repo.js';
import { resolveEventSettings } from '../settings/resolveEventSettings.js';
import { distributeMany, lockWaitlistEntries } from '../waitlist/distribute.js';
import { issueTickets } from '../tickets/issue.js';
import { HTTP_STATUS } from '../../config/http.js';

export const orderForSettlement = {
  items: { orderBy: { ticketTypeId: 'asc' } },
  user: { select: { email: true, displayName: true } },
  event: { select: { id: true, orgId: true, title: true, startsAt: true, timezone: true, status: true } },
} as const;

type SettlementOrder = NonNullable<Awaited<ReturnType<typeof loadOrderForUpdate>>>;

/**
 * Verrouille la commande (transitions sérialisées avec l'expiration, l'annulation, un autre webhook).
 * Ordre unique (audit B1) : l'événement est d'abord verrouillé FOR KEY SHARE (compatible avec les réservations et
 * les autres règlements, n'attend qu'une modification de l'événement en cours) — l'émission des billets prendrait
 * sinon ce verrou APRÈS les types de places, à l'inverse de `lockEvent` → types.
 */
export async function loadOrderForUpdate(tx: Tx, orderId: string) {
  const target = await tx.order.findUnique({ where: { id: orderId }, select: { eventId: true } });
  if (!target) return null;
  await tx.$queryRaw`SELECT "id" FROM "events" WHERE "id" = ${target.eventId}::uuid FOR KEY SHARE`;
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "orders" WHERE "id" = ${orderId}::uuid FOR UPDATE`;
  if (rows.length === 0) return null;
  return tx.order.findUnique({ where: { id: orderId }, include: orderForSettlement });
}

/** Transition gardée : ne change le statut que s'il vaut encore `from` ; vérifie le nombre de lignes. */
async function transition(tx: Tx, orderId: string, from: OrderStatus[], data: { status: OrderStatus } & Record<string, unknown>): Promise<void> {
  const { count } = await tx.order.updateMany({ where: { id: orderId, status: { in: from } }, data });
  if (count !== 1) throw new AppError(HTTP_STATUS.CONFLICT, 'INVALID_STATE', 'La commande a changé d’état entre-temps.');
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
 * Paiement reçu APRÈS l'échéance (contrat §4 « Paiement tardif ») : toutes les règles de vente sont
 * revérifiées à cet instant — ventes ouvertes, événement ni commencé ni annulé, plafond par personne.
 * La capacité est vérifiée par l'appelant (places encore bloquées, ou reprises sans priorité de la liste d'attente).
 * Le verrou (acheteur, événement) est pris APRÈS le verrou de commande : la réservation ne verrouille jamais
 * une commande existante, aucun cycle n'est donc possible ; il rend le plafond par personne exact.
 */
async function lateSaleAllowed(tx: Tx, order: SettlementOrder, countedInOwned: boolean): Promise<boolean> {
  await lockBuyerEvent(tx, order.userId, order.eventId);
  const event = await tx.event.findUniqueOrThrow({ where: { id: order.eventId }, include: { organization: { select: { settings: true } } } });
  const now = clock.now();
  if (event.status !== 'PUBLISHED' || now < event.salesStartAt || now >= event.salesEndAt || now >= event.startsAt) return false;
  if (!event.organization.settings) return false;
  const rules = resolveEventSettings(event.organization.settings, event);
  const quantity = order.items.reduce((n, i) => n + i.quantity, 0);
  // Une commande encore en attente est déjà comptée dans les places détenues.
  const owned = (await alreadyOwned(tx, order.userId, order.eventId)) - (countedInOwned ? quantity : 0);
  return owned + quantity <= rules.maxPerUser;
}

/** Paiement en retard sur une commande encore en attente (le worker n'est pas encore passé) : places toujours bloquées. */
export async function settleLateHeldOrder(tx: Tx, order: SettlementOrder, from: OrderStatus): Promise<'settled' | 'refused' | 'inconsistent'> {
  if (!(await lateSaleAllowed(tx, order, true))) return 'refused';
  return (await settleHeldOrder(tx, order, from)) ? 'settled' : 'inconsistent';
}

/**
 * Paiement arrivé APRÈS expiration : les places ont été libérées. On les reprend si toutes les règles de vente
 * sont encore respectées (voir lateSaleAllowed) et les places disponibles sans priorité de la liste d'attente,
 * sinon false. Le prix reste celui figé sur la commande.
 */
export async function tryResettleExpiredOrder(tx: Tx, order: SettlementOrder): Promise<boolean> {
  if (!(await lateSaleAllowed(tx, order, false))) return false;
  // Types verrouillés dans l'ordre des id (même ordre que la réservation).
  for (const item of order.items) {
    const rows = await tx.$queryRaw<{ ok: boolean }[]>`
      SELECT ("sold" + "held" + ${item.quantity} <= "capacity"
              AND NOT EXISTS (SELECT 1 FROM "waitlist_entries" w WHERE w."ticketTypeId" = t."id" AND w."status" = 'WAITING'
                                AND (w."quantity" <= t."capacity" - t."sold" - t."held"
                                     OR (w."accumulatingUntil" > ${clock.now()} AND NOT w."accumulationSkipped")))) AS ok
      FROM "ticket_types" t WHERE t."id" = ${item.ticketTypeId}::uuid AND t."eventId" = ${order.eventId}::uuid FOR UPDATE`;
    if (rows[0]?.ok !== true) return false;
  }
  for (const item of order.items) {
    const changed = await tx.$executeRaw`
      UPDATE "ticket_types" SET "sold" = "sold" + ${item.quantity}, "updatedAt" = ${clock.now()}
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
      createdAt: clock.now(),
      nextAttemptAt: clock.now(),
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
    if (reason === 'LATE_PAYMENT' && (order.status === 'EXPIRED' || order.status === 'PENDING_PAYMENT')) {
      await transition(tx, order.id, [order.status], { status: 'REFUNDED', refundAmountCents: amount, cancelledAt: clock.now() });
      if (order.status === 'PENDING_PAYMENT') {
        // Réservation refusée après l'échéance : ses places sont libérées et proposées à la liste d'attente.
        const typeIds = order.items.map((i) => i.ticketTypeId);
        await lockWaitlistEntries(tx, typeIds);
        for (const item of order.items) await releaseHeld(tx, order.eventId, item.ticketTypeId, item.quantity);
        await distributeMany(tx, typeIds);
      }
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
