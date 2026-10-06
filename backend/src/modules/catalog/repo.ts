import type { Prisma } from '../../generated/prisma/client.js';
import { getDb } from '../../lib/db.js';

const include = {
  organization: { select: { id: true, name: true, slug: true, settings: true } },
  ticketTypes: { orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }] },
} satisfies Prisma.EventInclude;

/** Catalogue public : uniquement les événements PUBLIÉS et non terminés. */
export function listPublished(filter: { orgSlug?: string; from?: Date; to?: Date }, page: number, pageSize: number) {
  const startsAt: Prisma.DateTimeFilter = {};
  if (filter.from) startsAt.gte = filter.from;
  if (filter.to) startsAt.lte = filter.to;
  const where: Prisma.EventWhereInput = {
    status: 'PUBLISHED',
    endsAt: { gt: new Date() },
    startsAt,
    ...(filter.orgSlug ? { organization: { slug: filter.orgSlug } } : {}),
  };
  const db = getDb();
  return Promise.all([
    db.event.findMany({ where, include, orderBy: [{ startsAt: 'asc' }, { id: 'asc' }], skip: (page - 1) * pageSize, take: pageSize }),
    db.event.count({ where }),
  ]);
}

export function findPublished(eventId: string) {
  return getDb().event.findFirst({ where: { id: eventId, status: 'PUBLISHED' }, include });
}

/** Nombre d'entrées en attente par type (les places libérées leur reviennent avant le public). */
export async function waitingCounts(ticketTypeIds: string[]): Promise<Map<string, number>> {
  if (ticketTypeIds.length === 0) return new Map();
  const rows = await getDb().waitlistEntry.groupBy({
    by: ['ticketTypeId'],
    where: { ticketTypeId: { in: ticketTypeIds }, status: 'WAITING' },
    _count: { _all: true },
  });
  return new Map(rows.map((r) => [r.ticketTypeId, r._count._all]));
}
