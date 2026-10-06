import type { Event, OrganizationSettings, Prisma, Role, TicketType } from '../../generated/prisma/client.js';
import { diff, writeAudit } from '../../lib/audit.js';
import { clock } from '../../lib/clock.js';
import { withTxRetry } from '../../lib/txRetry.js';
import { distributeWaitlist, lockWaitlistEntries, releaseOffer } from '../waitlist/distribute.js';
import { getDb, transaction, type Tx } from '../../lib/db.js';
import { errors, type FieldError } from '../../lib/errors.js';
import { iso } from '../../lib/schemas.js';
import { enqueueEmail } from '../../lib/outbox.js';
import { formatWithZone } from '../../lib/time.js';
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

export function toEventAdmin(event: EventWithTypes, settings: OrganizationSettings, cancellationPendingOrders = 0) {
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
    offlineCheckinEnabled: event.offlineCheckinEnabled,
    effectiveRules: toPublicRules(resolveEventSettings(settings, event)),
    ticketTypes: event.ticketTypes.map(toTicketTypeAdmin),
    cancellationPendingOrders,
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

/** Commandes d'un événement annulé restant à traiter par le worker (0 si l'événement n'est pas annulé). */
async function pendingCancellations(db: Tx, event: { id: string; status: string }): Promise<number> {
  if (event.status !== 'CANCELLED') return 0;
  return db.order.count({ where: { eventId: event.id, status: { in: ['PENDING_PAYMENT', 'AWAITING_TRANSFER', 'PAID'] } } });
}

async function load(tx: Tx, orgId: string, eventId: string) {
  const event = await repo.findEvent(tx, orgId, eventId);
  if (!event) throw errors.notFound();
  return toEventAdmin(event, await getSettings(tx, orgId), await pendingCancellations(tx, event));
}

export async function listEvents(orgId: string, status: EventStatusFilter, page: number, pageSize: number) {
  const [rows, total] = await repo.listEvents(orgId, status, page, pageSize);
  const settings = await transaction((tx) => getSettings(tx, orgId));
  const db = getDb();
  const items = await Promise.all(rows.map(async (e) => toEventAdmin(e, settings, await pendingCancellations(db, e))));
  return { items, page, pageSize, total };
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
  if (dates.endsAt.getTime() <= clock.now().getTime()) throw errors.validation([{ path: 'endsAt', message: 'L’événement doit se terminer dans le futur.' }]);
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

/**
 * Modification d'un événement (MANAGER+), avec invariants de dates revérifiés sur les valeurs FUSIONNÉES.
 * Report (dates de l'événement modifiées alors qu'il existe des commandes actives) : OWNER seulement,
 * motif obligatoire ; chaque commande payée obtient le droit au remboursement intégral (100 %, frais compris)
 * jusqu'à max(ancienne limite, nouveau début − délai figé) ; acheteurs prévenus par mail ; audit.
 */
export async function updateEvent(orgId: string, actor: { userId: string; role: Role }, eventId: string, body: EventPatchBody) {
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
    // Les tarifs early existants doivent rester dans la période de vente.
    const lateEarly = current.ticketTypes.filter((t) => t.earlyUntil !== null && t.earlyUntil.getTime() > dates.salesEndAt.getTime());
    if (lateEarly.length > 0) {
      throw errors.conflict('Un tarif early se termine après la fin des ventes : modifiez d’abord les types de places concernés.', {
        ticketTypeIds: lateEarly.map((t) => t.id),
      });
    }
    const rescheduled = dates.startsAt.getTime() !== current.startsAt.getTime() || dates.endsAt.getTime() !== current.endsAt.getTime();
    const activeOrders = rescheduled
      ? await tx.order.count({ where: { eventId, status: { in: ['PENDING_PAYMENT', 'AWAITING_TRANSFER', 'PAID'] } } })
      : 0;
    const isReport = rescheduled && activeOrders > 0;
    const offlineChanged = body.offlineCheckinEnabled !== undefined && body.offlineCheckinEnabled !== current.offlineCheckinEnabled;
    // Mode secours hors-ligne : décision réservée au propriétaire du collectif.
    if (body.offlineCheckinEnabled !== undefined && actor.role !== 'OWNER') throw errors.forbidden();
    if (isReport) {
      if (actor.role !== 'OWNER') throw errors.forbidden();
      if (!body.rescheduleReason) throw errors.validation([{ path: 'rescheduleReason', message: 'Le motif du report est obligatoire.' }]);
    }
    const settings = await getSettings(tx, orgId);
    const overrides = overridesData(body.overrides);
    checkOverrides({ ...overridesOf(current), ...overrides }, settings);
    const data: Prisma.EventUpdateInput = { ...dates, ...overrides };
    if (body.title !== undefined) data.title = body.title;
    if (body.description !== undefined) data.description = body.description;
    if (body.venue !== undefined) data.venue = body.venue;
    if (body.address !== undefined) data.address = body.address;
    if (body.isOnline !== undefined) data.isOnline = body.isOnline;
    if (body.timezone !== undefined) data.timezone = body.timezone;
    if (body.offlineCheckinEnabled !== undefined) data.offlineCheckinEnabled = body.offlineCheckinEnabled;
    await tx.event.update({ where: { id: current.id }, data });
    if (offlineChanged) {
      await writeAudit(tx, {
        orgId, actorId: actor.userId, action: 'event.offline_checkin', target: `event:${eventId}`,
        meta: { from: current.offlineCheckinEnabled, to: body.offlineCheckinEnabled },
      });
    }
    if (isReport && body.rescheduleReason) {
      await applyReschedule(tx, current, dates, body.rescheduleReason, settings, actor.userId);
    } else {
      await writeAudit(tx, {
        orgId, actorId: actor.userId, action: 'event.update', target: `event:${eventId}`,
        meta: { fields: Object.keys(body).filter((k) => k !== 'overrides' && k !== 'offlineCheckinEnabled'), overrides },
      });
    }
    return load(tx, orgId, eventId);
  });
}

async function applyReschedule(
  tx: Tx, before: EventWithTypes, dates: EventDates, reason: string, settings: OrganizationSettings, actorId: string,
): Promise<void> {
  const rules = resolveEventSettings(settings, before);
  const paid = await tx.order.findMany({
    where: { eventId: before.id, status: 'PAID' },
    select: { id: true, cancellableUntil: true },
  });
  for (const order of paid) {
    // Délai figé = ancien début − ancienne limite ; à défaut (annulation désactivée), délai effectif actuel.
    const deadlineMs = order.cancellableUntil
      ? before.startsAt.getTime() - order.cancellableUntil.getTime()
      : rules.cancellationDeadlineHours * 3600_000;
    const candidate = dates.startsAt.getTime() - deadlineMs;
    const cancellableUntil = new Date(Math.max(order.cancellableUntil?.getTime() ?? candidate, candidate));
    // Transition gardée : seule une commande toujours PAID est modifiée.
    await tx.order.updateMany({
      where: { id: order.id, status: 'PAID' },
      data: { cancellableUntil, refundPercent: 100, serviceFeeRefundable: true },
    });
  }
  const buyers = await tx.order.findMany({
    where: { eventId: before.id, status: { in: ['PENDING_PAYMENT', 'AWAITING_TRANSFER', 'PAID'] } },
    select: { user: { select: { email: true, displayName: true } } },
    distinct: ['userId'],
  });
  for (const { user } of buyers) {
    await enqueueEmail(tx, user.email, 'eventRescheduled', {
      displayName: user.displayName,
      eventTitle: before.title,
      oldDate: formatWithZone(before.startsAt, before.timezone),
      newDate: formatWithZone(dates.startsAt, before.timezone),
      reason,
    });
  }
  await writeAudit(tx, {
    orgId: before.orgId, actorId, action: 'event.reschedule', target: `event:${before.id}`,
    meta: {
      from: { startsAt: before.startsAt, endsAt: before.endsAt },
      to: { startsAt: dates.startsAt, endsAt: dates.endsAt },
      reason,
      paidOrders: paid.length,
      notifiedBuyers: buyers.length,
    },
  });
}

export async function publishEvent(orgId: string, actorId: string, eventId: string) {
  return transaction(async (tx) => {
    if (!(await repo.lockEvent(tx, orgId, eventId))) throw errors.notFound();
    const event = await repo.findEvent(tx, orgId, eventId);
    if (!event) throw errors.notFound();
    if (event.status !== 'DRAFT') throw errors.state('INVALID_STATE', 'Seul un brouillon peut être publié.');
    checkDates(event);
    if (event.salesEndAt.getTime() <= clock.now().getTime()) throw errors.conflict('La période de vente est déjà terminée : impossible de publier.');
    if (event.ticketTypes.length === 0) throw errors.conflict('Ajoutez au moins un type de place avant de publier.');
    const { count } = await tx.event.updateMany({ where: { id: eventId, orgId, status: 'DRAFT' }, data: { status: 'PUBLISHED' } });
    if (count !== 1) throw errors.state('INVALID_STATE', 'Seul un brouillon peut être publié.');
    await writeAudit(tx, { orgId, actorId, action: 'event.publish', target: `event:${eventId}` });
    return load(tx, orgId, eventId);
  });
}

/**
 * Annulation d'un événement (OWNER), contrat 1.14 :
 * 1. ICI, une petite transaction : statut CANCELLED (plus aucune vente ni scan), liste d'attente fermée
 *    (offres libérées), audit. Idempotente : un 2e appel renvoie le même état. Refusée si l'événement a commencé.
 * 2. Les commandes (remboursements, annulations, billets, mails) sont traitées en arrière-plan par le worker
 *    (`processEventCancellations`), une transaction par commande ; `cancellationPendingOrders` donne le reste.
 */
export async function cancelEvent(orgId: string, actorId: string, eventId: string, reason: string) {
  return withTxRetry(() => transaction(async (tx) => {
    if (!(await repo.lockEvent(tx, orgId, eventId))) throw errors.notFound();
    const current = await tx.event.findUniqueOrThrow({ where: { id: eventId }, select: { status: true, startsAt: true } });
    if (current.status === 'CANCELLED') return load(tx, orgId, eventId);
    if (current.startsAt.getTime() <= clock.now().getTime()) throw errors.conflict('L’événement a déjà commencé : il ne peut plus être annulé.');
    await tx.event.update({ where: { id: eventId }, data: { status: 'CANCELLED', cancelledAt: clock.now(), cancelReason: reason } });
    // Liste d'attente : entrées verrouillées (avant les types), offres libérées, file close.
    const typeIds = (await tx.ticketType.findMany({ where: { eventId }, select: { id: true }, orderBy: { id: 'asc' } })).map((t) => t.id);
    await lockWaitlistEntries(tx, typeIds);
    const offered = await tx.waitlistEntry.findMany({ where: { eventId, status: 'OFFERED' }, orderBy: { ticketTypeId: 'asc' } });
    for (const entry of offered) await releaseOffer(tx, entry);
    await tx.waitlistEntry.updateMany({ where: { eventId, status: { in: ['WAITING', 'OFFERED'] } }, data: { status: 'EXPIRED' } });
    const pending = await tx.order.count({ where: { eventId, status: { in: ['PENDING_PAYMENT', 'AWAITING_TRANSFER', 'PAID'] } } });
    await writeAudit(tx, { orgId, actorId, action: 'event.cancel', target: `event:${eventId}`, meta: { reason, ordersToProcess: pending, offersReleased: offered.length } });
    return load(tx, orgId, eventId);
  }));
}

// ---------------------------------------------------------------------------
// Types de places
// ---------------------------------------------------------------------------

interface EarlyState {
  priceCents: number;
  earlyPriceCents: number | null;
  earlyUntil: Date | null;
}

function checkEarly(s: EarlyState, salesEndAt: Date): void {
  const fields: FieldError[] = [];
  if (s.earlyUntil !== null && s.earlyUntil.getTime() > salesEndAt.getTime()) {
    fields.push({ path: 'earlyUntil', message: 'Le tarif early doit se terminer au plus tard à la fin des ventes.' });
  }
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
  return transaction(async (tx) => {
    const event = await lockActiveEvent(tx, orgId, eventId);
    checkEarly(early, event.salesEndAt);
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
    const event = await lockActiveEvent(tx, orgId, eventId);
    const current = await repo.findTicketType(tx, orgId, eventId, ticketTypeId);
    if (!current) throw errors.notFound();
    const early: EarlyState = {
      priceCents: body.priceCents ?? current.priceCents,
      earlyPriceCents: body.earlyPriceCents !== undefined ? body.earlyPriceCents : current.earlyPriceCents,
      earlyUntil: body.earlyUntil !== undefined ? (body.earlyUntil === null ? null : new Date(body.earlyUntil)) : current.earlyUntil,
    };
    checkEarly(early, event.salesEndAt);
    if (body.capacity !== undefined) {
      await lockWaitlistEntries(tx, [ticketTypeId]);
      // Réduction de capacité atomique : jamais sous les places vendues + bloquées, même en concurrence avec une réservation.
      const changed = await tx.$executeRaw`
        UPDATE "ticket_types" SET "capacity" = ${body.capacity}, "updatedAt" = now()
        WHERE "id" = ${ticketTypeId}::uuid AND "eventId" = ${eventId}::uuid AND "sold" + "held" <= ${body.capacity}`;
      if (changed !== 1) throw errors.conflict('La capacité ne peut pas être inférieure aux places vendues ou réservées.', { sold: current.sold, held: current.held });
      // Hausse de capacité : les nouvelles places vont d'abord à la liste d'attente.
      if (body.capacity > current.capacity) await distributeWaitlist(tx, ticketTypeId);
    }
    const data: Prisma.TicketTypeUpdateInput = { ...early };
    if (body.name !== undefined) data.name = body.name.trim();
    if (body.description !== undefined) data.description = body.description;
    if (body.sortOrder !== undefined) data.sortOrder = body.sortOrder;
    const tt = await tx.ticketType.update({ where: { id: ticketTypeId }, data });
    // Prix modifiés après ventes : autorisé, sans effet sur les commandes passées (prix figés) ; tracé avant / après.
    const snapshot = (t: TicketType) => ({
      name: t.name, capacity: t.capacity, priceCents: t.priceCents, earlyPriceCents: t.earlyPriceCents,
      earlyUntil: t.earlyUntil?.toISOString() ?? null, sortOrder: t.sortOrder,
    });
    await writeAudit(tx, {
      orgId, actorId, action: 'ticketType.update', target: `ticketType:${ticketTypeId}`,
      meta: { eventId, changes: diff(snapshot(current), snapshot(tt)), soldAtChange: current.sold },
    });
    return toTicketTypeAdmin(tt);
  });
}

export async function deleteTicketType(orgId: string, actorId: string, eventId: string, ticketTypeId: string): Promise<void> {
  await transaction(async (tx) => {
    const event = await lockActiveEvent(tx, orgId, eventId);
    // Ligne du type verrouillée AVANT les comptages : une réservation concurrente attend ou a déjà abouti.
    if (!(await repo.lockTicketType(tx, eventId, ticketTypeId))) throw errors.notFound();
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
