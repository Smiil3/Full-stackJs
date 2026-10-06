import { getEnv } from '../../config/env.js';
import { clock } from '../../lib/clock.js';
import type { Tx } from '../../lib/db.js';
import { enqueueEmail } from '../../lib/outbox.js';
import { addMinutes, formatWithZone } from '../../lib/time.js';
import { resolveEventSettings } from '../settings/resolveEventSettings.js';
import { getLogger } from '../../lib/logger.js';
import { alreadyOwned } from '../orders/repo.js';

/** Ventes ouvertes au sens de la liste d'attente (contrat 1.14) : salesStartAt ≤ now < min(salesEndAt, startsAt). */
export function salesOpen(event: { status: string; salesStartAt: Date; salesEndAt: Date; startsAt: Date }, now: Date): boolean {
  return event.status === 'PUBLISHED' && now >= event.salesStartAt && now < event.salesEndAt && now < event.startsAt;
}

/** Durée maximale de l'accumulation de places pour la tête de file (anti-gel des ventes). */
export const MAX_ACCUMULATION_MINUTES = 30;

/**
 * Distribue les places libres d'un type de place à la liste d'attente (contrat 1.14 §6), FIFO (createdAt, id) :
 * - la TÊTE de file (et elle seule) est servie en priorité : si sa demande dépasse les places libres, celles-ci
 *   s'accumulent pour elle (bloquées : ni offertes aux suivants ni vendues au public) UNE fois, pendant
 *   min(`waitlistOfferMinutes`, 30 min) ; passé ce délai, elle est sautée (rang conservé : servie dès que sa
 *   demande tiendra). Les entrées suivantes trop grosses sont sautées sans accumuler : N comptes jetables
 *   ne peuvent pas geler les ventes plus d'une fenêtre ;
 * - une entrée qui ferait dépasser le plafond par personne est écartée (EXPIRED, journalisé) ;
 * - uniquement ventes ouvertes, liste d'attente activée ; une offre bloque ses places pendant le délai de réponse.
 * Appelée dans la transaction qui libère des places, et par le worker. Ordre des verrous : entrées → ticket_types.
 */
export async function distributeWaitlist(tx: Tx, ticketTypeId: string): Promise<number> {
  const now = clock.now();
  const waiting = await tx.$queryRaw<{ id: string; quantity: number; userId: string; accumulatingUntil: Date | null; accumulationSkipped: boolean }[]>`
    SELECT "id", "quantity", "userId", "accumulatingUntil", "accumulationSkipped" FROM "waitlist_entries"
    WHERE "ticketTypeId" = ${ticketTypeId}::uuid AND "status" = 'WAITING'
    ORDER BY "createdAt", "id"
    FOR UPDATE`;
  if (waiting.length === 0) return 0;
  const rows = await tx.$queryRaw<{ free: number; eventId: string }[]>`
    SELECT ("capacity" - "sold" - "held")::int AS free, "eventId" FROM "ticket_types" WHERE "id" = ${ticketTypeId}::uuid FOR UPDATE`;
  const tt = rows[0];
  if (!tt || tt.free <= 0) return 0;
  const event = await tx.event.findUnique({
    where: { id: tt.eventId },
    include: { organization: { select: { settings: true } }, ticketTypes: { where: { id: ticketTypeId }, select: { name: true } } },
  });
  const settings = event?.organization.settings;
  if (!event || !settings || !salesOpen(event, now)) return 0;
  const rules = resolveEventSettings(settings, event);
  if (!rules.waitlistEnabled) return 0;

  let free = tt.free;
  let offered = 0;
  for (const [index, entry] of waiting.entries()) {
    if (free <= 0) break;
    if (entry.quantity > free) {
      if (entry.accumulationSkipped) continue;
      // Seule la tête de file réelle peut accumuler ; une autre demande trop grosse est simplement sautée.
      if (index > 0) continue;
      if (entry.accumulatingUntil === null) {
        // La tête de file commence à accumuler les places libérées pour elle.
        const minutes = Math.min(rules.waitlistOfferMinutes, MAX_ACCUMULATION_MINUTES);
        await tx.waitlistEntry.update({ where: { id: entry.id }, data: { accumulatingUntil: addMinutes(now, minutes) } });
        break;
      }
      if (now < entry.accumulatingUntil) break;
      // Délai d'accumulation échu : sautée (rang conservé), la suivante est servie.
      await tx.waitlistEntry.update({ where: { id: entry.id }, data: { accumulationSkipped: true } });
      continue;
    }
    const owned = await alreadyOwned(tx, entry.userId, event.id);
    if (owned + entry.quantity > rules.maxPerUser) {
      await tx.waitlistEntry.updateMany({ where: { id: entry.id, status: 'WAITING' }, data: { status: 'EXPIRED' } });
      getLogger().warn({ entryId: entry.id, owned, max: rules.maxPerUser }, 'entrée de liste d’attente écartée : plafond par personne atteint');
      continue;
    }
    const offerExpiresAt = new Date(Math.min(addMinutes(now, rules.waitlistOfferMinutes).getTime(), event.startsAt.getTime(), event.salesEndAt.getTime()));
    const held = await tx.$executeRaw`
      UPDATE "ticket_types" SET "held" = "held" + ${entry.quantity}, "updatedAt" = ${clock.now()}
      WHERE "id" = ${ticketTypeId}::uuid AND "eventId" = ${event.id}::uuid AND "sold" + "held" + ${entry.quantity} <= "capacity"`;
    if (held !== 1) break;
    const { count } = await tx.waitlistEntry.updateMany({
      where: { id: entry.id, status: 'WAITING' },
      data: { status: 'OFFERED', offeredAt: now, offerExpiresAt, accumulatingUntil: null },
    });
    if (count !== 1) throw new Error('Entrée de liste d’attente modifiée pendant la distribution');
    const user = await tx.user.findUniqueOrThrow({ where: { id: entry.userId }, select: { email: true, displayName: true } });
    await enqueueEmail(tx, user.email, 'waitlistOffer', {
      displayName: user.displayName,
      eventTitle: event.title,
      ticketTypeName: event.ticketTypes[0]?.name ?? '',
      quantity: entry.quantity,
      deadline: formatWithZone(offerExpiresAt, event.timezone),
      link: `${getEnv().frontUrl}/me/waitlist`,
    });
    free -= entry.quantity;
    offered += 1;
  }
  return offered;
}

/**
 * Types de places pour lesquels la liste d'attente prime sur le public (même règle que la réservation) :
 * une demande WAITING tient dans les places libres, ou la tête de file accumule encore des places.
 */
export async function waitlistBlockedTypes(db: Tx, ticketTypeIds: string[], now: Date): Promise<Set<string>> {
  if (ticketTypeIds.length === 0) return new Set();
  const rows = await db.$queryRaw<{ id: string }[]>`
    SELECT t."id" FROM "ticket_types" t
    WHERE t."id" = ANY(${ticketTypeIds}::uuid[]) AND EXISTS (
      SELECT 1 FROM "waitlist_entries" w
      WHERE w."ticketTypeId" = t."id" AND w."status" = 'WAITING'
        AND (w."quantity" <= t."capacity" - t."sold" - t."held"
             OR (w."accumulatingUntil" > ${now} AND NOT w."accumulationSkipped")))`;
  return new Set(rows.map((r) => r.id));
}

/**
 * Verrouille les entrées actives (WAITING / OFFERED) des types concernés AVANT toute écriture sur ces types :
 * ordre unique … → commandes → entrées de liste d'attente → ticket_types (pas d'interblocage avec
 * quitter / accepter / expirer une offre, qui verrouillent l'entrée puis le type).
 */
export async function lockWaitlistEntries(tx: Tx, ticketTypeIds: string[]): Promise<void> {
  if (ticketTypeIds.length === 0) return;
  await tx.$queryRaw`
    SELECT "id" FROM "waitlist_entries"
    WHERE "ticketTypeId" = ANY(${[...new Set(ticketTypeIds)]}::uuid[]) AND "status" IN ('WAITING', 'OFFERED')
    ORDER BY "createdAt", "id"
    FOR UPDATE`;
}

/** Distribution pour plusieurs types (triés par id : ordre de verrouillage constant). */
export async function distributeMany(tx: Tx, ticketTypeIds: Iterable<string>): Promise<void> {
  for (const id of [...new Set(ticketTypeIds)].sort()) await distributeWaitlist(tx, id);
}

/** Libère les places d'une offre (refus, expiration, annulation d'événement). */
export async function releaseOffer(tx: Tx, entry: { ticketTypeId: string; eventId: string; quantity: number }): Promise<void> {
  const changed = await tx.$executeRaw`
    UPDATE "ticket_types" SET "held" = "held" - ${entry.quantity}, "updatedAt" = ${clock.now()}
    WHERE "id" = ${entry.ticketTypeId}::uuid AND "eventId" = ${entry.eventId}::uuid AND "held" >= ${entry.quantity}`;
  if (changed !== 1) throw new Error('Incohérence de stock : places d’offre introuvables');
}
