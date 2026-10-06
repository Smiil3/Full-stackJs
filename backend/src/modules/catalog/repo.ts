import type { Prisma } from '../../generated/prisma/client.js';
import { getDb } from '../../lib/db.js';

export type PublicSettings = Prisma.OrganizationSettingsGetPayload<{ select: typeof settingsSelect }>;

// Réglages : uniquement les champs nécessaires aux règles publiques (jamais l'IBAN, même chiffré).
const settingsSelect = {
  orgId: true, cardHoldMinutes: true, transferHoldHours: true, transferEnabled: true, cancellationDeadlineHours: true,
  selfCancellationEnabled: true, refundPercent: true, serviceFeeRefundable: true, maxPerOrder: true, maxPerUser: true,
  waitlistOfferMinutes: true, waitlistEnabled: true, serviceFeeFixedCents: true, serviceFeeBasisPoints: true,
  contactEmail: true, bankBeneficiary: true, bankBic: true, bankIbanMasked: true,
} satisfies Prisma.OrganizationSettingsSelect;

const include = {
  organization: { select: { id: true, name: true, slug: true, settings: { select: settingsSelect } } },
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

/** Détail public : publié, et pas terminé depuis plus de `maxAgeDays` jours. */
export function findPublished(eventId: string, endedAfter: Date) {
  return getDb().event.findFirst({ where: { id: eventId, status: 'PUBLISHED', endsAt: { gt: endedAfter } }, include });
}

/** Plus petite demande en attente par type (les places libérées reviennent d'abord à la liste d'attente). */
export async function smallestWaiting(ticketTypeIds: string[]): Promise<Map<string, number>> {
  if (ticketTypeIds.length === 0) return new Map();
  const rows = await getDb().waitlistEntry.groupBy({
    by: ['ticketTypeId'],
    where: { ticketTypeId: { in: ticketTypeIds }, status: 'WAITING' },
    _min: { quantity: true },
  });
  return new Map(rows.flatMap((r) => (r._min.quantity === null ? [] : [[r.ticketTypeId, r._min.quantity] as const])));
}
