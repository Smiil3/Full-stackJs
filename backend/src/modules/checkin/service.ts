import { clock } from '../../lib/clock.js';
import { getDb } from '../../lib/db.js';
import { iso } from '../../lib/schemas.js';

/** Événements à contrôler (SCANNER+) : publiés, terminés depuis moins de 24 h ; aucun chiffre de vente. */
export async function listCheckinEvents(orgId: string) {
  const since = new Date(clock.now().getTime() - 24 * 3600_000);
  const rows = await getDb().event.findMany({
    where: { orgId, status: 'PUBLISHED', endsAt: { gt: since } },
    select: { id: true, title: true, venue: true, isOnline: true, startsAt: true, endsAt: true, timezone: true, status: true },
    orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
    take: 100,
  });
  return {
    items: rows.map((e) => ({
      id: e.id, title: e.title, venue: e.venue, isOnline: e.isOnline,
      startsAt: iso(e.startsAt), endsAt: iso(e.endsAt), timezone: e.timezone, status: e.status,
    })),
  };
}
