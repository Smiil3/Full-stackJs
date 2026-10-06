import type { Event, OrganizationSettings, Prisma, TicketType } from '../../generated/prisma/client.js';
import { writeAudit } from '../../lib/audit.js';
import { transaction, type Tx } from '../../lib/db.js';
import { errors, type FieldError } from '../../lib/errors.js';
import { iso } from '../../lib/schemas.js';
import { getSettings } from '../orgs/repo.js';
import { OVERRIDE_KEYS, overridesOf, resolveEventSettings, toPublicRules, type EventOverrideFields } from '../settings/resolveEventSettings.js';
import * as repo from './repo.js';
import type { EventCreateBody, EventPatchBody, OverridesInput, TicketTypeBody, TicketTypePatchBody } from './schemas.js';

type EventWithTypes = Event & { ticketTypes: TicketType[] };

export function toTicketTypeAdmin(tt: TicketType) {
  return {
    id: tt.id,
    name: tt.name,
    description: tt.description,
    capacity: tt.capacity,
    sold: tt.sold,
    held: tt.held,
    remaining: tt.capacity - tt.sold - tt.held,
    priceCents: tt.priceCents,
    earlyPriceCents: tt.earlyPriceCents,
    earlyUntil: iso(tt.earlyUntil),
    sortOrder: tt.sortOrder,
  };
}

export function toEventAdmin(event: EventWithTypes, settings: OrganizationSettings) {
  return {
    id: event.id,
    orgId: event.orgId,
    title: event.title,
    description: event.description,
    venue: event.venue,
    address: event.address,
    isOnline: event.isOnline,
    startsAt: iso(event.startsAt),
    endsAt: iso(event.endsAt),
    timezone: event.timezone,
    status: event.status,
    salesStartAt: iso(event.salesStartAt),
    salesEndAt: iso(event.salesEndAt),
    overrides: overridesOf(event),
    effectiveRules: toPublicRules(resolveEventSettings(settings, event)),
    ticketTypes: event.ticketTypes.map(toTicketTypeAdmin),
    createdAt: iso(event.createdAt),
    updatedAt: iso(event.updatedAt),
  };
}

interface EventDates {
  startsAt: Date;
  endsAt: Date;
  salesStartAt: Date;
  salesEndAt: Date;
}

/** Cohérence des dates (aussi garantie par une contrainte CHECK en base). */
function checkDates(d: EventDates): void {
  const fields: FieldError[] = [];
  if (d.endsAt.getTime() <= d.startsAt.getTime()) fields.push({ path: 'endsAt', message: 'La fin doit être postérieure au début.' });
  if (d.salesEndAt.getTime() <= d.salesStartAt.getTime()) fields.push({ path: 'salesEndAt', message: 'La fin des ventes doit être postérieure à leur ouverture.' });
  if (d.salesEndAt.getTime() > d.endsAt.getTime()) fields.push({ path: 'salesEndAt', message: 'Les ventes doivent se terminer au plus tard à la fin de l’événement.' });
  if (fields.length > 0) throw errors.validation(fields);
}

/** Plafonds explicites incohérents sur l'événement (la résolution borne de toute façon maxPerOrder ≤ maxPerUser). */
function checkOverrides(merged: EventOverrideFields, settings: OrganizationSettings): void {
  const maxPerUser = merged.maxPerUser ?? settings.maxPerUser;
  const maxPerOrder = merged.maxPerOrder ?? settings.maxPerOrder;
  if (maxPerUser < maxPerOrder) {
    throw errors.validation([{ path: 'overrides.maxPerUser', message: 'Le plafond par personne doit être supérieur ou égal au plafond par commande.' }]);
  }
}

/** Mapping explicite des surcharges (jamais d'objet client passé tel quel à Prisma). */
function overridesData(input: OverridesInput | undefined): Partial<EventOverrideFields> {
  const data: Record<string, unknown> = {};
  if (!input) return data;
  for (const key of OVERRIDE_KEYS) {
    const value = input[key];
    if (value !== undefined) data[key] = value;
  }
  return data;
}

async function load(tx: Tx, orgId: string, eventId: string) {
  const event = await repo.findEvent(tx, orgId, eventId);
  if (!event) throw errors.notFound();
  return toEventAdmin(event, await getSettings(tx, orgId));
}

export async function listEvents(orgId: string, status: EventStatusFilter, page: number, pageSize: number) {
  const [rows, total] = await repo.listEvents(orgId, status, page, pageSize);
  const settings = await transaction((tx) => getSettings(tx, orgId));
  return { items: rows.map((e) => toEventAdmin(e, settings)), page, pageSize, total };
}
type EventStatusFilter = 'DRAFT' | 'PUBLISHED' | 'CANCELLED' | undefined;

export function getEvent(orgId: string, eventId: string) {
  return transaction((tx) => load(tx, orgId, eventId));
}

export async function createEvent(orgId: string, actorId: string, body: EventCreateBody) {
  const dates: EventDates = {
    startsAt: new Date(body.startsAt),
    endsAt: new Date(body.endsAt),
    salesStartAt: new Date(body.salesStartAt),
    salesEndAt: new Date(body.salesEndAt),
  };
  checkDates(dates);
  if (dates.endsAt.getTime() <= Date.now()) throw errors.validation([{ path: 'endsAt', message: 'L’événement doit se terminer dans le futur.' }]);
  return transaction(async (tx) => {
    const settings = await getSettings(tx, orgId);
    const overrides = overridesData(body.overrides);
    checkOverrides({ ...emptyOverrides(), ...overrides }, settings);
    const event = await tx.event.create({
      data: {
        orgId,
        title: body.title.trim(),
        description: body.description ?? null,
        venue: body.venue ?? null,
        address: body.address ?? null,
        isOnline: body.isOnline,
        timezone: body.timezone,
        ...dates,
        ...overrides,
      },
    });
    await writeAudit(tx, { orgId, actorId, action: 'event.create', target: `event:${event.id}`, meta: { title: event.title } });
    return load(tx, orgId, event.id);
  });
}

function emptyOverrides(): EventOverrideFields {
  return Object.fromEntries(OVERRIDE_KEYS.map((k) => [k, null])) as unknown as EventOverrideFields;
}

export async function updateEvent(orgId: string, actorId: string, eventId: string, body: EventPatchBody) {
  return transaction(async (tx) => {
    if (!(await repo.lockEvent(tx, orgId, eventId))) throw errors.notFound();
    const current = await repo.findEvent(tx, orgId, eventId);
    if (!current) throw errors.notFound();
    if (current.status === 'CANCELLED') throw errors.state('INVALID_STATE', 'Un événement annulé ne peut plus être modifié.');
    const dates: EventDates = {
      startsAt: body.startsAt ? new Date(body.startsAt) : current.startsAt,
      endsAt: body.endsAt ? new Date(body.endsAt) : current.endsAt,
      salesStartAt: body.salesStartAt ? new Date(body.salesStartAt) : current.salesStartAt,
      salesEndAt: body.salesEndAt ? new Date(body.salesEndAt) : current.salesEndAt,
    };
    checkDates(dates);
    const settings = await getSettings(tx, orgId);
    const overrides = overridesData(body.overrides);
    checkOverrides({ ...overridesOf(current), ...overrides }, settings);
    const data: Prisma.EventUpdateInput = { ...dates, ...overrides };
    if (body.title !== undefined) data.title = body.title.trim();
    if (body.description !== undefined) data.description = body.description;
    if (body.venue !== undefined) data.venue = body.venue;
    if (body.address !== undefined) data.address = body.address;
    if (body.isOnline !== undefined) data.isOnline = body.isOnline;
    if (body.timezone !== undefined) data.timezone = body.timezone;
    await tx.event.update({ where: { id: current.id }, data });
    await writeAudit(tx, {
      orgId, actorId, action: 'event.update', target: `event:${eventId}`,
      meta: { fields: Object.keys(body).filter((k) => k !== 'overrides'), overrides: overrides },
    });
    return load(tx, orgId, eventId);
  });
}

export async function publishEvent(orgId: string, actorId: string, eventId: string) {
  return transaction(async (tx) => {
    if (!(await repo.lockEvent(tx, orgId, eventId))) throw errors.notFound();
    const event = await repo.findEvent(tx, orgId, eventId);
    if (!event) throw errors.notFound();
    if (event.status !== 'DRAFT') throw errors.state('INVALID_STATE', 'Seul un brouillon peut être publié.');
    if (event.ticketTypes.length === 0) throw errors.conflict('Ajoutez au moins un type de place avant de publier.');
    const { count } = await tx.event.updateMany({ where: { id: eventId, orgId, status: 'DRAFT' }, data: { status: 'PUBLISHED' } });
    if (count !== 1) throw errors.state('INVALID_STATE', 'Seul un brouillon peut être publié.');
    await writeAudit(tx, { orgId, actorId, action: 'event.publish', target: `event:${eventId}` });
    return load(tx, orgId, eventId);
  });
}

// ---------------------------------------------------------------------------
// Types de places
// ---------------------------------------------------------------------------

interface EarlyState {
  priceCents: number;
  earlyPriceCents: number | null;
  earlyUntil: Date | null;
}

function checkEarly(s: EarlyState): void {
  const fields: FieldError[] = [];
  if ((s.earlyPriceCents === null) !== (s.earlyUntil === null)) {
    fields.push({ path: 'earlyPriceCents', message: 'Le tarif early exige un prix ET une date de fin (ou aucun des deux).' });
  } else if (s.earlyPriceCents !== null && s.earlyPriceCents >= s.priceCents) {
    fields.push({ path: 'earlyPriceCents', message: 'Le tarif early doit être inférieur au prix normal.' });
  }
  if (fields.length > 0) throw errors.validation(fields);
}

async function lockActiveEvent(tx: Tx, orgId: string, eventId: string) {
  if (!(await repo.lockEvent(tx, orgId, eventId))) throw errors.notFound();
  const event = await repo.findEvent(tx, orgId, eventId);
  if (!event) throw errors.notFound();
  if (event.status === 'CANCELLED') throw errors.state('INVALID_STATE', 'Un événement annulé ne peut plus être modifié.');
  return event;
}

export async function createTicketType(orgId: string, actorId: string, eventId: string, body: TicketTypeBody) {
  const early: EarlyState = {
    priceCents: body.priceCents,
    earlyPriceCents: body.earlyPriceCents ?? null,
    earlyUntil: body.earlyUntil ? new Date(body.earlyUntil) : null,
  };
  checkEarly(early);
  return transaction(async (tx) => {
    const event = await lockActiveEvent(tx, orgId, eventId);
    const tt = await tx.ticketType.create({
      data: {
        eventId: event.id,
        name: body.name.trim(),
        description: body.description ?? null,
        capacity: body.capacity,
        sortOrder: body.sortOrder ?? event.ticketTypes.length,
        ...early,
      },
    });
    await writeAudit(tx, { orgId, actorId, action: 'ticketType.create', target: `ticketType:${tt.id}`, meta: { eventId, capacity: tt.capacity, priceCents: tt.priceCents } });
    return toTicketTypeAdmin(tt);
  });
}

export async function updateTicketType(orgId: string, actorId: string, eventId: string, ticketTypeId: string, body: TicketTypePatchBody) {
  return transaction(async (tx) => {
    await lockActiveEvent(tx, orgId, eventId);
    const current = await repo.findTicketType(tx, orgId, eventId, ticketTypeId);
    if (!current) throw errors.notFound();
    const early: EarlyState = {
      priceCents: body.priceCents ?? current.priceCents,
      earlyPriceCents: body.earlyPriceCents !== undefined ? body.earlyPriceCents : current.earlyPriceCents,
      earlyUntil: body.earlyUntil !== undefined ? (body.earlyUntil === null ? null : new Date(body.earlyUntil)) : current.earlyUntil,
    };
    checkEarly(early);
    if (body.capacity !== undefined) {
      // Réduction de capacité atomique : jamais sous les places vendues + bloquées, même en concurrence avec une réservation.
      const changed = await tx.$executeRaw`
        UPDATE "ticket_types" SET "capacity" = ${body.capacity}, "updatedAt" = now()
        WHERE "id" = ${ticketTypeId}::uuid AND "sold" + "held" <= ${body.capacity}`;
      if (changed !== 1) throw errors.conflict('La capacité ne peut pas être inférieure aux places vendues ou réservées.', { sold: current.sold, held: current.held });
    }
    const data: Prisma.TicketTypeUpdateInput = { ...early };
    if (body.name !== undefined) data.name = body.name.trim();
    if (body.description !== undefined) data.description = body.description;
    if (body.sortOrder !== undefined) data.sortOrder = body.sortOrder;
    const tt = await tx.ticketType.update({ where: { id: ticketTypeId }, data });
    await writeAudit(tx, { orgId, actorId, action: 'ticketType.update', target: `ticketType:${ticketTypeId}`, meta: { fields: Object.keys(body) } });
    return toTicketTypeAdmin(tt);
  });
}

export async function deleteTicketType(orgId: string, actorId: string, eventId: string, ticketTypeId: string): Promise<void> {
  await transaction(async (tx) => {
    const event = await lockActiveEvent(tx, orgId, eventId);
    const current = await repo.findTicketType(tx, orgId, eventId, ticketTypeId);
    if (!current) throw errors.notFound();
    const [orders, waitlist] = await Promise.all([
      tx.orderItem.count({ where: { ticketTypeId } }),
      tx.waitlistEntry.count({ where: { ticketTypeId } }),
    ]);
    if (orders > 0 || waitlist > 0 || current.sold + current.held > 0) {
      throw errors.conflict('Ce type de place a déjà des commandes ou une liste d’attente : il ne peut pas être supprimé.');
    }
    if (event.status === 'PUBLISHED' && event.ticketTypes.length <= 1) {
      throw errors.conflict('Un événement publié doit garder au moins un type de place.');
    }
    await tx.ticketType.delete({ where: { id: ticketTypeId } });
    await writeAudit(tx, { orgId, actorId, action: 'ticketType.delete', target: `ticketType:${ticketTypeId}`, meta: { eventId, name: current.name } });
  });
}
