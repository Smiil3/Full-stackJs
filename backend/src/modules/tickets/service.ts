import { clock } from '../../lib/clock.js';
import { getDb } from '../../lib/db.js';
import { iso } from '../../lib/schemas.js';
import { qrPayloadFor } from '../../lib/ticketSigning.js';
import { MY_TICKETS_MAX } from '../../config/events.js';

/**
 * Billets de l'acheteur (commandes payées, remboursées ou annulées : statut du billet à l'appui).
 * Ordre : événements à venir (du plus proche au plus lointain), puis passés (du plus récent au plus ancien).
 */
export async function myTickets(userId: string) {
  const tickets = await getDb().ticket.findMany({
    where: { orderItem: { order: { userId } } },
    include: {
      orderItem: { select: { orderId: true, ticketType: { select: { name: true } } } },
      event: { select: { id: true, title: true, venue: true, isOnline: true, startsAt: true, endsAt: true, timezone: true } },
    },
    orderBy: [{ event: { startsAt: 'asc' } }, { createdAt: 'asc' }, { seq: 'asc' }],
    take: MY_TICKETS_MAX,
  });
  const now = clock.now().getTime();
  const upcoming = tickets.filter((t) => t.event.endsAt.getTime() > now);
  const past = tickets.filter((t) => t.event.endsAt.getTime() <= now).reverse();
  return {
    items: [...upcoming, ...past].map((t) => ({
      id: t.id,
      publicId: t.publicId,
      status: t.status,
      usedAt: iso(t.usedAt),
      qrPayload: qrPayloadFor(t.eventId, t.publicId),
      ticketTypeName: t.orderItem.ticketType.name,
      orderId: t.orderItem.orderId,
      event: {
        id: t.event.id, title: t.event.title, venue: t.event.venue, isOnline: t.event.isOnline,
        startsAt: iso(t.event.startsAt), endsAt: iso(t.event.endsAt), timezone: t.event.timezone,
      },
    })),
  };
}
