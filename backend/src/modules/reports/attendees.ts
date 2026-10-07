import type { Response } from 'express';
import { writeAudit } from '../../lib/audit.js';
import { csvIdentifier, csvRow, UTF8_BOM } from '../../lib/csv.js';
import { getDb } from '../../lib/db.js';
import { errors } from '../../lib/errors.js';
import { formatInTimezone } from '../../lib/time.js';
import { getLogger } from '../../lib/logger.js';
import { HTTP_STATUS } from '../../config/http.js';
import { CSV_EXPORT_PAGE } from '../../config/worker.js';
import { EXPORT_AUDIT_DEDUP_MS } from '../../config/events.js';
import { clock } from '../../lib/clock.js';

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
  // Une ligne d'audit par (compte, événement) sur EXPORT_AUDIT_DEDUP_MS : des exports répétés ne noient pas l'audit.
  const recent = await db.auditLog.count({
    where: { orgId, actorId, action: 'attendees.export', target: `event:${eventId}`, createdAt: { gte: new Date(clock.now().getTime() - EXPORT_AUDIT_DEDUP_MS) } },
  });
  if (recent === 0) await db.$transaction((tx) => writeAudit(tx, { orgId, actorId, action: 'attendees.export', target: `event:${eventId}`, meta: {} }));

  res.status(HTTP_STATUS.OK);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="participants-${eventId}.csv"`);
  res.setHeader('Cache-Control', 'no-store');
  // Client parti (onglet fermé, réseau coupé) : on arrête de lire la base, sans boucle pendante.
  const stream = { closed: false };
  res.on('close', () => {
    stream.closed = true;
  });
  const write = async (chunk: string): Promise<void> => {
    if (stream.closed) return;
    if (!res.write(chunk)) {
      // Contre-pression : on attend « drain » OU « close », puis on retire les DEUX écouteurs (aucune accumulation).
      await new Promise<void>((resolve) => {
        const done = () => {
          res.off('drain', done);
          res.off('close', done);
          resolve();
        };
        res.on('drain', done);
        res.on('close', done);
      });
    }
  };
  try {
    await write(UTF8_BOM + csvRow(['billet', 'type', 'nom', 'email', 'statut', 'scanne_le']));
    let cursor: string | undefined;
    while (!stream.closed) {
      const tickets = await db.ticket.findMany({
        where: { eventId },
        include: { orderItem: { select: { ticketType: { select: { name: true } }, order: { select: { user: { select: { displayName: true, email: true } } } } } } },
        orderBy: { id: 'asc' },
        take: CSV_EXPORT_PAGE,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      });
      if (tickets.length === 0) break;
      let chunk = '';
      for (const t of tickets) {
        chunk += csvRow([
          csvIdentifier(t.publicId),
          t.orderItem.ticketType.name,
          t.orderItem.order.user.displayName,
          t.orderItem.order.user.email,
          STATUS_LABELS[t.status],
          t.usedAt ? formatInTimezone(t.usedAt, event.timezone) : null,
        ]);
      }
      await write(chunk);
      cursor = tickets[tickets.length - 1]?.id;
      if (tickets.length < CSV_EXPORT_PAGE) break;
    }
  } catch (err) {
    // En-têtes déjà envoyés : on ne peut plus répondre en erreur. La connexion est détruite pour que le
    // client voie un téléchargement ÉCHOUÉ (et non un fichier tronqué présenté comme complet).
    getLogger().error({ err, eventId }, 'export CSV interrompu par une erreur');
    res.destroy(err instanceof Error ? err : new Error('export interrompu'));
    return;
  }
  if (!stream.closed) res.end();
}
