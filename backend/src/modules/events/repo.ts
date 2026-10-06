import type { Prisma } from '../../generated/prisma/client.js';
import { getDb, type Tx } from '../../lib/db.js';

const withTypes = { ticketTypes: { orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }] } } satisfies Prisma.EventInclude;

/** Événement d'un collectif : l'orgId fait partie du filtre (événement d'un autre collectif ⇒ introuvable). */
export function findEvent(db: Tx, orgId: string, eventId: string) {
  return db.event.findFirst({ where: { id: eventId, orgId }, include: withTypes });
}

export async function lockEvent(tx: Tx, orgId: string, eventId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "events" WHERE "id" = ${eventId}::uuid AND "orgId" = ${orgId}::uuid FOR UPDATE`;
  return rows.length === 1;
}

export function listEvents(orgId: string, status: 'DRAFT' | 'PUBLISHED' | 'CANCELLED' | undefined, page: number, pageSize: number) {
  const db = getDb();
  const where: Prisma.EventWhereInput = status ? { orgId, status } : { orgId };
  return Promise.all([
    db.event.findMany({ where, include: withTypes, orderBy: [{ startsAt: 'asc' }, { id: 'asc' }], skip: (page - 1) * pageSize, take: pageSize }),
    db.event.count({ where }),
  ]);
}

/** Verrouille un type de place (clé parente incluse). */
export async function lockTicketType(tx: Tx, eventId: string, ticketTypeId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "ticket_types" WHERE "id" = ${ticketTypeId}::uuid AND "eventId" = ${eventId}::uuid FOR UPDATE`;
  return rows.length === 1;
}

export function findTicketType(db: Tx, orgId: string, eventId: string, ticketTypeId: string) {
  return db.ticketType.findFirst({ where: { id: ticketTypeId, eventId, event: { orgId } } });
}
