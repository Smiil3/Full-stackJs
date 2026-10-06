import { getEnv } from '../../config/env.js';
import { clock } from '../../lib/clock.js';
import type { Tx } from '../../lib/db.js';
import { enqueueEmail } from '../../lib/outbox.js';
import { addMinutes, formatWithZone } from '../../lib/time.js';
import { resolveEventSettings } from '../settings/resolveEventSettings.js';

/**
 * Distribue les places libres d'un type de place à la liste d'attente, dans l'ordre FIFO (createdAt, id) :
 * chaque entrée WAITING dont la quantité tient dans les places libres reçoit une OFFRE qui bloque ses places
 * (`held`) pendant le délai de réponse ; une entrée trop grosse garde son rang sans bloquer les suivantes.
 * Appelée dans la transaction qui libère des places (expiration, annulation, remboursement, capacité),
 * et périodiquement par le worker. Le type de place est verrouillé (ordre : … → ticket_types).
 */
export async function distributeWaitlist(tx: Tx, ticketTypeId: string): Promise<number> {
  const rows = await tx.$queryRaw<{ free: number; eventId: string }[]>`
    SELECT ("capacity" - "sold" - "held")::int AS free, "eventId" FROM "ticket_types" WHERE "id" = ${ticketTypeId}::uuid FOR UPDATE`;
  const tt = rows[0];
  if (!tt || tt.free <= 0) return 0;
  const event = await tx.event.findUnique({
    where: { id: tt.eventId },
    include: { organization: { select: { settings: true } }, ticketTypes: { where: { id: ticketTypeId }, select: { name: true } } },
  });
  const settings = event?.organization.settings;
  const now = clock.now();
  if (!event || !settings || event.status !== 'PUBLISHED' || now >= event.startsAt) return 0;
  const rules = resolveEventSettings(settings, event);
  if (!rules.waitlistEnabled) return 0;

  let free = tt.free;
  let offered = 0;
  const waiting = await tx.$queryRaw<{ id: string; quantity: number; userId: string }[]>`
    SELECT "id", "quantity", "userId" FROM "waitlist_entries"
    WHERE "ticketTypeId" = ${ticketTypeId}::uuid AND "status" = 'WAITING'
    ORDER BY "createdAt", "id"
    FOR UPDATE`;
  for (const entry of waiting) {
    if (free <= 0) break;
    if (entry.quantity > free) continue;
    const offerExpiresAt = new Date(Math.min(addMinutes(now, rules.waitlistOfferMinutes).getTime(), event.startsAt.getTime()));
    const held = await tx.$executeRaw`
      UPDATE "ticket_types" SET "held" = "held" + ${entry.quantity}, "updatedAt" = now()
      WHERE "id" = ${ticketTypeId}::uuid AND "eventId" = ${event.id}::uuid AND "sold" + "held" + ${entry.quantity} <= "capacity"`;
    if (held !== 1) break;
    const { count } = await tx.waitlistEntry.updateMany({
      where: { id: entry.id, status: 'WAITING' },
      data: { status: 'OFFERED', offeredAt: now, offerExpiresAt },
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

/** Distribution pour plusieurs types (triés par id : ordre de verrouillage constant). */
export async function distributeMany(tx: Tx, ticketTypeIds: Iterable<string>): Promise<void> {
  for (const id of [...new Set(ticketTypeIds)].sort()) await distributeWaitlist(tx, id);
}

/** Libère les places d'une offre (refus, expiration, annulation d'événement). */
export async function releaseOffer(tx: Tx, entry: { ticketTypeId: string; eventId: string; quantity: number }): Promise<void> {
  const changed = await tx.$executeRaw`
    UPDATE "ticket_types" SET "held" = "held" - ${entry.quantity}, "updatedAt" = now()
    WHERE "id" = ${entry.ticketTypeId}::uuid AND "eventId" = ${entry.eventId}::uuid AND "held" >= ${entry.quantity}`;
  if (changed !== 1) throw new Error('Incohérence de stock : places d’offre introuvables');
}
