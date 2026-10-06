import { once } from 'node:events';
import type { Response } from 'express';
import { writeAudit } from '../../lib/audit.js';
import { csvRow, UTF8_BOM } from '../../lib/csv.js';
import { getDb } from '../../lib/db.js';
import { errors } from '../../lib/errors.js';
import { formatInTimezone } from '../../lib/time.js';

const PAGE = 500;
const STATUS_LABELS = { VALID: 'valide', USED: 'scanné', CANCELLED: 'annulé' } as const;

/**
 * Export CSV des participants (MANAGER+), en streaming par pages (mémoire bornée, contre-pression respectée) :
 * séparateur `;`, BOM UTF-8, heure de scan dans le fuseau de l'événement, cellules protégées contre
 * l'injection de formules. L'export est tracé dans l'audit.
 */
export async function streamAttendees(orgId: string, actorId: string, eventId: string, res: Response): Promise<void> {
  const db = getDb();
  const event = await db.event.findFirst({ where: { id: eventId, orgId }, select: { id: true, timezone: true, title: true } });
  if (!event) throw errors.notFound();
  await db.$transaction((tx) => writeAudit(tx, { orgId, actorId, action: 'attendees.export', target: `event:${eventId}`, meta: {} }));

  res.status(200);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="participants-${eventId}.csv"`);
  const write = async (chunk: string) => {
    if (!res.write(chunk)) await once(res, 'drain');
  };
  await write(UTF8_BOM + csvRow(['billet', 'type', 'nom', 'email', 'statut', 'scanne_le']));
  let cursor: string | undefined;
  for (;;) {
    const tickets = await db.ticket.findMany({
      where: { eventId },
      include: { orderItem: { select: { ticketType: { select: { name: true } }, order: { select: { user: { select: { displayName: true, email: true } } } } } } },
      orderBy: { id: 'asc' },
      take: PAGE,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });
    if (tickets.length === 0) break;
    let chunk = '';
    for (const t of tickets) {
      chunk += csvRow([
        t.publicId,
        t.orderItem.ticketType.name,
        t.orderItem.order.user.displayName,
        t.orderItem.order.user.email,
        STATUS_LABELS[t.status],
        t.usedAt ? formatInTimezone(t.usedAt, event.timezone) : null,
      ]);
    }
    await write(chunk);
    cursor = tickets[tickets.length - 1]?.id;
    if (tickets.length < PAGE) break;
  }
  res.end();
}
