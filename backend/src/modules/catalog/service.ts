import type { Event, TicketType } from '../../generated/prisma/client.js';
import { clock } from '../../lib/clock.js';
import { errors } from '../../lib/errors.js';
import { availabilityOf, bestAvailability, priceAt } from '../../lib/pricing.js';
import { iso } from '../../lib/schemas.js';
import { resolveEventSettings, toPublicRules } from '../settings/resolveEventSettings.js';
import * as repo from './repo.js';
import { getDb } from '../../lib/db.js';
import { waitlistBlockedTypes } from '../waitlist/distribute.js';
import { PUBLIC_RETENTION_MS } from '../../config/events.js';

type CatalogEvent = Event & {
  organization: { id: string; name: string; slug: string; settings: repo.PublicSettings | null };
  ticketTypes: TicketType[];
};

function summary(e: CatalogEvent, waiting: Set<string>, now: Date) {
  const availabilities = e.ticketTypes.map((t) => availabilityOf(t, waiting.has(t.id)));
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
  if (filter.from && filter.to && new Date(filter.from).getTime() > new Date(filter.to).getTime()) {
    throw errors.validation([{ path: 'to', message: '« to » doit être postérieur ou égal à « from ».' }]);
  }
  const [rows, total] = await repo.listPublished(
    {
      ...(filter.orgSlug ? { orgSlug: filter.orgSlug } : {}),
      ...(filter.from ? { from: new Date(filter.from) } : {}),
      ...(filter.to ? { to: new Date(filter.to) } : {}),
    },
    page,
    pageSize,
  );
  const waiting = await waitlistBlockedTypes(getDb(), rows.flatMap((e) => e.ticketTypes.map((t) => t.id)), clock.now());
  const now = clock.now();
  return { items: rows.map((e) => summary(e, waiting, now)), page, pageSize, total };
}

/** Détail public : prix courants (early calculé serveur), disponibilité sans chiffre exact, règles effectives. */
export async function getEvent(eventId: string) {
  const e = await repo.findPublished(eventId, new Date(clock.now().getTime() - PUBLIC_RETENTION_MS));
  if (!e?.organization.settings) throw errors.notFound();
  const settings = e.organization.settings;
  const waiting = await waitlistBlockedTypes(getDb(), e.ticketTypes.map((t) => t.id), clock.now());
  const now = clock.now();
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
        availability: availabilityOf(t, waiting.has(t.id)),
      };
    }),
    rules: toPublicRules(resolveEventSettings(settings, e)),
    contactEmail: settings.contactEmail,
  };
}
