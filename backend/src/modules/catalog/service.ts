import type { Event, OrganizationSettings, TicketType } from '../../generated/prisma/client.js';
import { errors } from '../../lib/errors.js';
import { availabilityOf, bestAvailability, priceAt } from '../../lib/pricing.js';
import { iso } from '../../lib/schemas.js';
import { resolveEventSettings, toPublicRules } from '../settings/resolveEventSettings.js';
import * as repo from './repo.js';

type CatalogEvent = Event & {
  organization: { id: string; name: string; slug: string; settings: OrganizationSettings | null };
  ticketTypes: TicketType[];
};

function summary(e: CatalogEvent, waiting: Map<string, number>, now: Date) {
  const availabilities = e.ticketTypes.map((t) => availabilityOf(t, waiting.get(t.id) ?? 0));
  const prices = e.ticketTypes.map((t) => priceAt(t, now).unitPriceCents);
  return {
    id: e.id,
    orgId: e.organization.id,
    orgName: e.organization.name,
    orgSlug: e.organization.slug,
    title: e.title,
    venue: e.venue,
    isOnline: e.isOnline,
    startsAt: iso(e.startsAt),
    endsAt: iso(e.endsAt),
    timezone: e.timezone,
    coverAvailability: bestAvailability(availabilities),
    fromPriceCents: prices.length > 0 ? Math.min(...prices) : 0,
  };
}

export async function listEvents(filter: { orgSlug?: string; from?: string; to?: string }, page: number, pageSize: number) {
  const [rows, total] = await repo.listPublished(
    {
      ...(filter.orgSlug ? { orgSlug: filter.orgSlug } : {}),
      ...(filter.from ? { from: new Date(filter.from) } : {}),
      ...(filter.to ? { to: new Date(filter.to) } : {}),
    },
    page,
    pageSize,
  );
  const waiting = await repo.waitingCounts(rows.flatMap((e) => e.ticketTypes.map((t) => t.id)));
  const now = new Date();
  return { items: rows.map((e) => summary(e, waiting, now)), page, pageSize, total };
}

/** Détail public : prix courants (early calculé serveur), disponibilité sans chiffre exact, règles effectives. */
export async function getEvent(eventId: string) {
  const e = await repo.findPublished(eventId);
  if (!e?.organization.settings) throw errors.notFound();
  const settings = e.organization.settings;
  const waiting = await repo.waitingCounts(e.ticketTypes.map((t) => t.id));
  const now = new Date();
  return {
    ...summary(e, waiting, now),
    description: e.description,
    address: e.address,
    salesStartAt: iso(e.salesStartAt),
    salesEndAt: iso(e.salesEndAt),
    salesOpen: now >= e.salesStartAt && now < e.salesEndAt,
    ticketTypes: e.ticketTypes.map((t) => {
      const price = priceAt(t, now);
      return {
        id: t.id,
        name: t.name,
        description: t.description,
        currentPriceCents: price.unitPriceCents,
        regularPriceCents: t.priceCents,
        isEarly: price.isEarly,
        earlyUntil: price.isEarly ? iso(t.earlyUntil) : null,
        availability: availabilityOf(t, waiting.get(t.id) ?? 0),
      };
    }),
    rules: toPublicRules(resolveEventSettings(settings, e)),
    contactEmail: settings.contactEmail,
  };
}
