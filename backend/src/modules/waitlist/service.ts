import { randomUUID } from 'node:crypto';
import type { WaitlistEntry } from '../../generated/prisma/client.js';
import { clock } from '../../lib/clock.js';
import { getDb, transaction, type Tx } from '../../lib/db.js';
import { errors } from '../../lib/errors.js';
import { computeServiceFee, lineTotal } from '../../lib/money.js';
import { priceAt } from '../../lib/pricing.js';
import { iso } from '../../lib/schemas.js';
import { addHours, addMinutes } from '../../lib/time.js';
import { alreadyOwned, lockBuyerEvent, lockEventShared } from '../orders/repo.js';
import { viewOwnOrder } from '../orders/service.js';
import { resolveEventSettings } from '../settings/resolveEventSettings.js';
import { distributeMany, distributeWaitlist, eventTicketTypeIds, lockWaitlistEntries, recordUnhonoredOffer, releaseOffer } from './distribute.js';
import { salesOpen } from './rules.js';
import { withTxRetry } from '../../lib/txRetry.js';
import { SHA256_HEX_LENGTH } from '../../config/crypto.js';
import { WAITLIST_OFFERS_PER_TICK, WAITLIST_SWEEP_TYPES_PER_TICK } from '../../config/worker.js';
import { MAX_UNHONORED_OFFERS_PER_EVENT, WAITLIST_LEAVE_GRACE_MINUTES } from '../../config/waitlist.js';
import { minutes } from '../../config/units.js';
import { TimeBudget } from '../../lib/budget.js';

type EntryWithNames = WaitlistEntry & { event: { title: string }; ticketType: { name: string } };

async function position(db: Tx, entry: WaitlistEntry): Promise<number | null> {
  if (entry.status !== 'WAITING') return null;
  const ahead = await db.$queryRaw<{ n: number }[]>`
    SELECT COUNT(*)::int AS n FROM "waitlist_entries"
    WHERE "ticketTypeId" = ${entry.ticketTypeId}::uuid AND "status" = 'WAITING'
      AND ("createdAt", "id") < (${entry.createdAt}, ${entry.id}::uuid)`;
  return (ahead[0]?.n ?? 0) + 1;
}

async function toView(db: Tx, e: EntryWithNames) {
  // Offres non honorées du compte sur CET événement (contrat 1.18 §6) : 0 à MAX_UNHONORED_OFFERS_PER_EVENT.
  const unhonoredOffers = await db.waitlistEntry.count({ where: { userId: e.userId, eventId: e.eventId, offerExpired: true } });
  return {
    id: e.id, eventId: e.eventId, eventTitle: e.event.title, ticketTypeId: e.ticketTypeId, ticketTypeName: e.ticketType.name,
    quantity: e.quantity, status: e.status, position: await position(db, e), offerExpiresAt: iso(e.offerExpiresAt),
    unhonoredOffers: Math.min(unhonoredOffers, MAX_UNHONORED_OFFERS_PER_EVENT), createdAt: iso(e.createdAt),
  };
}

const withNames = { event: { select: { title: true } }, ticketType: { select: { name: true } } } as const;

/**
 * Inscription en liste d'attente : seulement si le type est réellement complet pour cette demande,
 * dans le respect des plafonds (une entrée active par type, quantité ≤ plafond par commande,
 * places détenues + attendues ≤ plafond par personne).
 */
export async function join(userId: string, eventId: string, ticketTypeId: string, quantity: number) {
  return withTxRetry(() => transaction(async (tx) => {
    await lockBuyerEvent(tx, userId, eventId);
    if (!(await lockEventShared(tx, eventId))) throw errors.notFound();
    const event = await tx.event.findUnique({
      where: { id: eventId },
      include: { organization: { select: { settings: true } }, ticketTypes: { where: { id: ticketTypeId } } },
    });
    const tt = event?.ticketTypes[0];
    if (!event || event.status === 'DRAFT' || !tt || !event.organization.settings) throw errors.notFound();
    if (!salesOpen(event, clock.now())) throw errors.state('SALES_CLOSED', 'Les ventes ne sont pas ouvertes pour cet événement.');
    const rules = resolveEventSettings(event.organization.settings, event);
    if (!rules.waitlistEnabled) throw errors.state('WAITLIST_DISABLED', 'La liste d’attente n’est pas ouverte pour cet événement.');
    if (quantity > rules.maxPerOrder) {
      throw errors.unprocessable('LIMIT_EXCEEDED', `Au plus ${rules.maxPerOrder} place(s) par demande.`, { max: rules.maxPerOrder, alreadyOwned: 0 });
    }
    // Anti-gel (contrat 1.18 §6) : un compte qui n'a pas honoré deux offres sur l'événement n'y revient pas.
    if (await tx.waitlistEntry.count({ where: { userId, eventId, offerExpired: true } }) >= MAX_UNHONORED_OFFERS_PER_EVENT) {
      throw errors.conflict('Vous n’avez pas donné suite à plusieurs offres pour cet événement : la liste d’attente ne vous est plus ouverte.');
    }
    if (await tx.waitlistEntry.findFirst({ where: { userId, ticketTypeId, status: { in: ['WAITING', 'OFFERED'] } } })) {
      throw errors.state('ALREADY_IN_WAITLIST', 'Vous êtes déjà en liste d’attente pour ce type de place.');
    }
    const waitingRows = await tx.$queryRaw<{ n: number }[]>`
      SELECT COALESCE(SUM("quantity"), 0)::int AS n FROM "waitlist_entries"
      WHERE "userId" = ${userId}::uuid AND "eventId" = ${eventId}::uuid AND "status" = 'WAITING'`;
    const owned = (await alreadyOwned(tx, userId, eventId)) + (waitingRows[0]?.n ?? 0);
    if (owned + quantity > rules.maxPerUser) {
      throw errors.unprocessable('LIMIT_EXCEEDED', `Au plus ${rules.maxPerUser} place(s) par personne pour cet événement.`, { max: rules.maxPerUser, alreadyOwned: owned });
    }
    // Le public pourrait acheter cette quantité tout de suite ⇒ pas de liste d'attente.
    const free = tt.capacity - tt.sold - tt.held;
    const blocking = await tx.waitlistEntry.count({ where: { ticketTypeId, status: 'WAITING', quantity: { lte: Math.max(free, 0) } } });
    if (free >= quantity && blocking === 0) throw errors.state('NOT_SOLD_OUT', 'Des places sont disponibles : réservez directement.');
    const entry = await tx.waitlistEntry.create({ data: { id: randomUUID(), ticketTypeId, eventId, userId, quantity } });
    await distributeWaitlist(tx, ticketTypeId);
    const fresh = await tx.waitlistEntry.findUniqueOrThrow({ where: { id: entry.id }, include: withNames });
    return toView(tx, fresh);
  }));
}

export async function myWaitlist(userId: string) {
  const db = getDb();
  const rows = await db.waitlistEntry.findMany({ where: { userId }, include: withNames, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 200 });
  return { items: await Promise.all(rows.map((e) => toView(db, e))) };
}

/** Entrée de l'acheteur (userId dans le filtre) verrouillée ; sinon 404. */
async function lockOwnEntry(tx: Tx, userId: string, entryId: string): Promise<WaitlistEntry> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "waitlist_entries" WHERE "id" = ${entryId}::uuid AND "userId" = ${userId}::uuid FOR UPDATE`;
  if (rows.length === 0) throw errors.notFound();
  return tx.waitlistEntry.findUniqueOrThrow({ where: { id: entryId } });
}

/**
 * Quitter la liste : une offre en cours libère ses places, qui passent aussitôt au suivant. Quitter une offre plus
 * de WAITLIST_LEAVE_GRACE_MINUTES après son émission compte comme une offre NON HONORÉE (contrat 1.18 §6, audit
 * M'2 : sinon garder l'offre jusqu'au bout puis la quitter gelait les places sans pénalité).
 */
export async function leave(userId: string, entryId: string): Promise<void> {
  await withTxRetry(() => transaction(async (tx) => {
    // Ordre unique (audit B1) : entrées actives de l'événement (createdAt, id) AVANT l'entrée propre.
    const target = await tx.waitlistEntry.findFirst({ where: { id: entryId, userId }, select: { eventId: true } });
    if (!target) throw errors.notFound();
    await lockWaitlistEntries(tx, await eventTicketTypeIds(tx, target.eventId));
    const entry = await lockOwnEntry(tx, userId, entryId);
    if (entry.status !== 'WAITING' && entry.status !== 'OFFERED') throw errors.state('INVALID_STATE', 'Cette inscription n’est plus active.');
    await tx.waitlistEntry.updateMany({ where: { id: entry.id, status: entry.status }, data: { status: 'LEFT' } });
    if (entry.status !== 'OFFERED') return;
    await releaseOffer(tx, entry);
    const late = entry.offeredAt !== null && clock.now().getTime() - entry.offeredAt.getTime() > minutes(WAITLIST_LEAVE_GRACE_MINUTES);
    const affected = late ? (await recordUnhonoredOffer(tx, entry.id)).affected : new Set([entry.ticketTypeId]);
    await distributeMany(tx, affected);
  }));
}

/**
 * Acceptation d'une offre : commande CARD en attente de paiement sur les places DÉJÀ bloquées par l'offre
 * (aucune nouvelle réservation), prix calculés à l'instant de l'acceptation, mêmes règles figées qu'une commande.
 * Ordre des verrous : événement (partagé) → entrée → … ; ventes ouvertes ; l'échéance de l'offre fait foi ;
 * plafond par personne revérifié (l'offre est déjà comptée dans les places détenues).
 */
export async function accept(userId: string, entryId: string) {
  const orderId = await withTxRetry(() => transaction(async (tx) => {
    const target = await tx.waitlistEntry.findFirst({ where: { id: entryId, userId }, select: { eventId: true } });
    if (!target) throw errors.notFound();
    await lockEventShared(tx, target.eventId);
    const entry = await lockOwnEntry(tx, userId, entryId);
    if (entry.status === 'CONVERTED') {
      const existing = await tx.order.findUnique({ where: { waitlistEntryId: entry.id }, select: { id: true } });
      if (existing) return existing.id;
    }
    const now = clock.now();
    if (entry.status !== 'OFFERED' || !entry.offerExpiresAt || entry.offerExpiresAt <= now) {
      throw errors.state('OFFER_EXPIRED', 'Cette offre a expiré.');
    }
    const event = await tx.event.findUniqueOrThrow({
      where: { id: entry.eventId },
      include: { organization: { select: { settings: true } }, ticketTypes: { where: { id: entry.ticketTypeId } } },
    });
    const tt = event.ticketTypes[0];
    if (!tt || !event.organization.settings || !salesOpen(event, now)) {
      throw errors.state('SALES_CLOSED', 'Les ventes sont terminées pour cet événement.');
    }
    const rules = resolveEventSettings(event.organization.settings, event);
    const owned = await alreadyOwned(tx, userId, event.id);
    if (owned > rules.maxPerUser) {
      throw errors.unprocessable('LIMIT_EXCEEDED', `Au plus ${rules.maxPerUser} place(s) par personne pour cet événement.`, { max: rules.maxPerUser, alreadyOwned: owned - entry.quantity });
    }
    const unitPriceCents = priceAt(tt, now).unitPriceCents;
    const subtotalCents = lineTotal(unitPriceCents, entry.quantity);
    const serviceFeeCents = computeServiceFee(subtotalCents, rules.serviceFeeFixedCents, rules.serviceFeeBasisPoints);
    const free = subtotalCents + serviceFeeCents === 0;
    const { count } = await tx.waitlistEntry.updateMany({ where: { id: entry.id, status: 'OFFERED' }, data: { status: 'CONVERTED' } });
    if (count !== 1) throw errors.state('OFFER_EXPIRED', 'Cette offre a expiré.');
    const order = await tx.order.create({
      data: {
        userId, eventId: event.id, waitlistEntryId: entry.id,
        status: 'PENDING_PAYMENT', paymentMethod: 'CARD',
        idempotencyKey: randomUUID(), requestHash: `waitlist:${entry.id}`.padEnd(SHA256_HEX_LENGTH, '0').slice(0, SHA256_HEX_LENGTH),
        subtotalCents, serviceFeeCents, totalCents: subtotalCents + serviceFeeCents,
        refundPercent: rules.refundPercent, serviceFeeRefundable: rules.serviceFeeRefundable,
        cancellableUntil: rules.selfCancellationEnabled ? addHours(event.startsAt, -rules.cancellationDeadlineHours) : null,
        expiresAt: new Date(Math.min(addMinutes(now, rules.cardHoldMinutes).getTime(), event.startsAt.getTime())),
        createdAt: now,
        items: { create: [{ ticketTypeId: tt.id, quantity: entry.quantity, unitPriceCents }] },
      },
    });
    if (free) {
      // Offre gratuite : confirmée immédiatement (places bloquées → vendues, billets).
      const { settleHeldOrder, loadOrderForUpdate } = await import('../payments/settle.js');
      const loaded = await loadOrderForUpdate(tx, order.id);
      // Résultat vérifié : une offre gratuite qui ne peut pas être confirmée n'est pas convertie (rollback).
      if (!loaded || !(await settleHeldOrder(tx, loaded, 'PENDING_PAYMENT'))) {
        throw errors.conflict('Stock incohérent pour cette offre : réessayez ou contactez l’organisateur.');
      }
    }
    return order.id;
  }));
  return transaction((tx) => viewOwnOrder(tx, userId, orderId));
}

/**
 * Worker : offres échues ⇒ EXPIRED, places libérées et proposées au suivant. Une transaction par offre, rejouée
 * sur interblocage. Ordre unique (audit B1) : entrées actives de TOUS les types de l'événement (createdAt, id)
 * verrouillées avant l'offre elle-même. Anti-gel (contrat 1.17 §6) : à la 2e offre laissée expirer sur l'événement,
 * les autres inscriptions du compte sur cet événement sortent de la liste (EXPIRED).
 */
export async function expireWaitlistOffers(budget: TimeBudget = TimeBudget.unlimited()): Promise<{ expired: number; excluded: number }> {
  let expired = 0;
  let excluded = 0;
  const skipped: string[] = [];
  for (let i = 0; i < WAITLIST_OFFERS_PER_TICK && !budget.exhausted(); i += 1) {
    const done = await withTxRetry(() => transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ id: string; eventId: string }[]>`
        SELECT "id", "eventId" FROM "waitlist_entries"
        WHERE "status" = 'OFFERED' AND "offerExpiresAt" <= ${clock.now()} AND NOT ("id" = ANY(${skipped}::uuid[]))
        ORDER BY "offerExpiresAt", "id" LIMIT 1`;
      const candidate = rows[0];
      if (!candidate) return false;
      await lockWaitlistEntries(tx, await eventTicketTypeIds(tx, candidate.eventId));
      const entry = await tx.waitlistEntry.findUniqueOrThrow({ where: { id: candidate.id } });
      // Acceptée, quittée ou déjà expirée entre-temps : rien à faire (plus jamais reprise dans ce passage).
      if (entry.status !== 'OFFERED' || !entry.offerExpiresAt || entry.offerExpiresAt > clock.now()) {
        skipped.push(entry.id);
        return true;
      }
      await tx.waitlistEntry.update({ where: { id: entry.id }, data: { status: 'EXPIRED' } });
      await releaseOffer(tx, entry);
      expired += 1;
      const outcome = await recordUnhonoredOffer(tx, entry.id);
      if (outcome.excluded) excluded += 1;
      await distributeMany(tx, outcome.affected);
      return true;
    }));
    if (!done) break;
  }
  return { expired, excluded };
}

/** Worker : filet de sécurité — distribue les places libres de tout type ayant des personnes en attente. */
export async function sweepWaitlist(): Promise<{ offered: number }> {
  const types = await getDb().$queryRaw<{ id: string }[]>`
    SELECT DISTINCT t."id" FROM "ticket_types" t JOIN "waitlist_entries" w ON w."ticketTypeId" = t."id"
    WHERE w."status" = 'WAITING' AND t."sold" + t."held" < t."capacity" ORDER BY t."id" LIMIT ${WAITLIST_SWEEP_TYPES_PER_TICK}`;
  let offered = 0;
  for (const { id } of types) offered += await transaction((tx) => distributeWaitlist(tx, id));
  return { offered };
}
