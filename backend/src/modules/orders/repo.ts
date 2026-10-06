import type { Prisma } from '../../generated/prisma/client.js';
import { getDb, type Tx } from '../../lib/db.js';

export const orderInclude = {
  event: { select: { title: true, startsAt: true, timezone: true } },
  items: { include: { ticketType: { select: { name: true } } }, orderBy: { id: 'asc' } },
} satisfies Prisma.OrderInclude;

export type OrderWithDetails = Prisma.OrderGetPayload<{ include: typeof orderInclude }>;

/** Commande d'un acheteur : le userId fait partie du filtre (commande d'autrui ⇒ introuvable). */
export function findOwnOrder(db: Tx, userId: string, orderId: string) {
  return db.order.findFirst({ where: { id: orderId, userId }, include: orderInclude });
}

export function findByIdempotencyKey(db: Tx, userId: string, key: string) {
  return db.order.findUnique({ where: { userId_idempotencyKey: { userId, idempotencyKey: key } }, include: orderInclude });
}

export function listOwnOrders(userId: string, page: number, pageSize: number) {
  const db = getDb();
  return Promise.all([
    db.order.findMany({ where: { userId }, include: orderInclude, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (page - 1) * pageSize, take: pageSize }),
    db.order.count({ where: { userId } }),
  ]);
}

/** Nombre de billets déjà scannés par commande (une commande dont un billet a servi n'est plus annulable). */
export async function scannedCounts(db: Tx, orderIds: string[]): Promise<Map<string, number>> {
  if (orderIds.length === 0) return new Map();
  const rows = await db.$queryRaw<{ orderId: string; n: number }[]>`
    SELECT oi."orderId", COUNT(*)::int AS n
    FROM "tickets" t JOIN "order_items" oi ON oi."id" = t."orderItemId"
    WHERE oi."orderId" = ANY(${orderIds}::uuid[]) AND t."status" = 'USED'
    GROUP BY oi."orderId"`;
  return new Map(rows.map((r) => [r.orderId, r.n]));
}

/** Verrou transactionnel par (acheteur, événement) : sérialise ses commandes ⇒ plafond par personne exact. */
export async function lockBuyerEvent(tx: Tx, userId: string, eventId: string): Promise<void> {
  const key = `order:${userId}:${eventId}`;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
}

/**
 * Verrou PARTAGÉ sur l'événement : plusieurs réservations simultanées ne se bloquent pas entre elles,
 * mais attendent une annulation / un report en cours (FOR UPDATE) et voient son résultat.
 */
export async function lockEventShared(tx: Tx, eventId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "events" WHERE "id" = ${eventId}::uuid FOR SHARE`;
  return rows.length === 1;
}

/** Places déjà détenues pour l'événement : commandes actives + offres de liste d'attente en cours. */
export async function alreadyOwned(tx: Tx, userId: string, eventId: string): Promise<number> {
  const rows = await tx.$queryRaw<{ n: number }[]>`
    SELECT (
      COALESCE((SELECT SUM(oi."quantity") FROM "order_items" oi JOIN "orders" o ON o."id" = oi."orderId"
                WHERE o."userId" = ${userId}::uuid AND o."eventId" = ${eventId}::uuid
                  AND o."status" IN ('PENDING_PAYMENT', 'AWAITING_TRANSFER', 'PAID')), 0)
    + COALESCE((SELECT SUM(w."quantity") FROM "waitlist_entries" w
                WHERE w."userId" = ${userId}::uuid AND w."eventId" = ${eventId}::uuid AND w."status" = 'OFFERED'), 0)
    )::int AS n`;
  return rows[0]?.n ?? 0;
}

/**
 * Réservation atomique d'un type de place : la condition de stock est évaluée par Postgres sur la ligne
 * verrouillée par l'UPDATE lui-même. Aucune survente possible, quel que soit le nombre de requêtes
 * simultanées. Refusé aussi si des personnes attendent en liste d'attente (elles sont prioritaires).
 */
export async function reserve(tx: Tx, eventId: string, ticketTypeId: string, quantity: number, now: Date): Promise<boolean> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    UPDATE "ticket_types" SET "held" = "held" + ${quantity}, "updatedAt" = now()
    WHERE "id" = ${ticketTypeId}::uuid AND "eventId" = ${eventId}::uuid
      AND "sold" + "held" + ${quantity} <= "capacity"
      -- Priorité à la liste d'attente : bloqué seulement si une personne en attente pourrait être servie
      -- avec les places libres (une demande trop grosse ne bloque ni les suivantes ni le public).
      AND NOT EXISTS (SELECT 1 FROM "waitlist_entries" w
                      WHERE w."ticketTypeId" = ${ticketTypeId}::uuid AND w."status" = 'WAITING'
                        AND (w."quantity" <= "capacity" - "sold" - "held"
                             -- La tête de file accumule les places libérées pour elle (contrat 1.14 §6).
                             OR (w."accumulatingUntil" > ${now} AND NOT w."accumulationSkipped")))
    RETURNING "id"`;
  return rows.length === 1;
}

/** Libère des places bloquées (expiration, annulation d'une commande non payée). */
export async function releaseHeld(tx: Tx, eventId: string, ticketTypeId: string, quantity: number): Promise<void> {
  const changed = await tx.$executeRaw`
    UPDATE "ticket_types" SET "held" = "held" - ${quantity}, "updatedAt" = now()
    WHERE "id" = ${ticketTypeId}::uuid AND "eventId" = ${eventId}::uuid AND "held" >= ${quantity}`;
  if (changed !== 1) throw new Error('Incohérence de stock : places bloquées insuffisantes');
}

/** Bloquées → vendues (paiement confirmé). */
export async function heldToSold(tx: Tx, eventId: string, ticketTypeId: string, quantity: number): Promise<void> {
  const changed = await tx.$executeRaw`
    UPDATE "ticket_types" SET "held" = "held" - ${quantity}, "sold" = "sold" + ${quantity}, "updatedAt" = now()
    WHERE "id" = ${ticketTypeId}::uuid AND "eventId" = ${eventId}::uuid AND "held" >= ${quantity}`;
  if (changed !== 1) throw new Error('Incohérence de stock : places bloquées insuffisantes');
}
