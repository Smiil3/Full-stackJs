import type { OrderStatus } from '../../generated/prisma/client.js';
import { clock } from '../../lib/clock.js';
import { getDb } from '../../lib/db.js';
import { errors } from '../../lib/errors.js';
import { iso } from '../../lib/schemas.js';

const STATUSES: OrderStatus[] = ['PENDING_PAYMENT', 'AWAITING_TRANSFER', 'PAID', 'EXPIRED', 'CANCELLED', 'REFUNDED'];

interface TypeRow { ticketTypeId: string; name: string; capacity: number; sold: number; held: number; checkedIn: number; grossCents: number; refundedCents: number }

/**
 * Chiffres temps réel d'un événement (MANAGER+), agrégés en SQL :
 * - revenueCents = encaissé net sur les billets (lignes des commandes payées / remboursées − parts remboursées),
 *   frais de service à part (serviceFeeCents = frais encaissés − frais remboursés) ;
 * - refundsToProcess = remboursements à traiter à la main (MANUAL_REQUIRED + FAILED).
 */
export async function eventStats(orgId: string, eventId: string) {
  const db = getDb();
  const event = await db.event.findFirst({ where: { id: eventId, orgId }, select: { id: true } });
  if (!event) throw errors.notFound();
  const types = await db.$queryRaw<TypeRow[]>`
    SELECT t."id" AS "ticketTypeId", t."name", t."capacity", t."sold", t."held",
      (SELECT COUNT(*) FROM "tickets" k JOIN "order_items" oi ON oi."id" = k."orderItemId"
        WHERE oi."ticketTypeId" = t."id" AND k."status" = 'USED')::int AS "checkedIn",
      COALESCE((SELECT SUM(oi."unitPriceCents" * oi."quantity") FROM "order_items" oi JOIN "orders" o ON o."id" = oi."orderId"
        WHERE oi."ticketTypeId" = t."id" AND o."status" IN ('PAID', 'REFUNDED') AND o."paidAt" IS NOT NULL), 0)::int AS "grossCents",
      COALESCE((SELECT SUM(oi."refundedCents") FROM "order_items" oi JOIN "orders" o ON o."id" = oi."orderId"
        WHERE oi."ticketTypeId" = t."id" AND o."status" IN ('PAID', 'REFUNDED') AND o."paidAt" IS NOT NULL), 0)::int AS "refundedCents"
    FROM "ticket_types" t WHERE t."eventId" = ${eventId}::uuid
    ORDER BY t."sortOrder", t."createdAt", t."id"`;
  const fees = await db.$queryRaw<{ collected: number; refunded: number }[]>`
    SELECT COALESCE(SUM(o."serviceFeeCents"), 0)::int AS collected,
           COALESCE(SUM(GREATEST(0, COALESCE(o."refundAmountCents", 0)
             - (SELECT COALESCE(SUM(oi."refundedCents"), 0) FROM "order_items" oi WHERE oi."orderId" = o."id"))), 0)::int AS refunded
    FROM "orders" o WHERE o."eventId" = ${eventId}::uuid AND o."status" IN ('PAID', 'REFUNDED') AND o."paidAt" IS NOT NULL`;
  const byStatus = await db.order.groupBy({ by: ['status'], where: { eventId }, _count: { _all: true } });
  const [waitlistWaiting, refundsToProcess] = await Promise.all([
    db.waitlistEntry.count({ where: { eventId, status: 'WAITING' } }),
    db.refund.count({ where: { order: { eventId }, status: { in: ['MANUAL_REQUIRED', 'FAILED'] } } }),
  ]);
  const ticketTypes = types.map((t) => ({
    ticketTypeId: t.ticketTypeId, name: t.name, capacity: t.capacity, sold: t.sold, held: t.held,
    remaining: t.capacity - t.sold - t.held, checkedIn: t.checkedIn,
    revenueCents: t.grossCents - t.refundedCents, refundedCents: t.refundedCents,
  }));
  const sum = (k: 'capacity' | 'sold' | 'held' | 'remaining' | 'checkedIn' | 'revenueCents' | 'refundedCents') => ticketTypes.reduce((n, t) => n + t[k], 0);
  const fee = fees[0] ?? { collected: 0, refunded: 0 };
  const ordersByStatus = Object.fromEntries(STATUSES.map((s) => [s, byStatus.find((b) => b.status === s)?._count._all ?? 0])) as Record<OrderStatus, number>;
  return {
    eventId,
    generatedAt: iso(clock.now()),
    currency: 'EUR' as const,
    ticketTypes,
    totals: {
      capacity: sum('capacity'), sold: sum('sold'), held: sum('held'), remaining: sum('remaining'), checkedIn: sum('checkedIn'),
      revenueCents: sum('revenueCents'), refundedCents: sum('refundedCents') + fee.refunded, serviceFeeCents: fee.collected - fee.refunded,
      refundsToProcess,
    },
    ordersByStatus,
    waitlistWaiting,
  };
}
