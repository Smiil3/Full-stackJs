import type { Prisma } from '../../generated/prisma/client.js';
import { MAX_RESCHEDULE_FAILURES, STUCK_RESCHEDULE_AFTER_MS } from '../../config/worker.js';
import { writeAudit } from '../../lib/audit.js';
import { clock } from '../../lib/clock.js';
import { getDb, transaction, type Tx } from '../../lib/db.js';
import { errors } from '../../lib/errors.js';
import { iso } from '../../lib/schemas.js';

/**
 * Report « bloqué » (contrat 1.18 §8, audit B'6) : non terminé ET (au moins une commande écartée après
 * MAX_RESCHEDULE_FAILURES échecs, OU lancé depuis plus de STUCK_RESCHEDULE_AFTER_MS — worker arrêté…).
 */
async function stuckWhere(db: Tx): Promise<Prisma.EventRescheduleWhereInput> {
  // Reports ayant au moins une commande écartée (pas de relation Prisma sur pendingRescheduleId : deux temps).
  const failed = await db.order.findMany({
    where: { pendingRescheduleId: { not: null }, rescheduleFailures: { gte: MAX_RESCHEDULE_FAILURES } },
    select: { pendingRescheduleId: true }, distinct: ['pendingRescheduleId'],
  });
  const failedIds = failed.map((o) => o.pendingRescheduleId).filter((id): id is string => id !== null);
  return {
    completedAt: null,
    OR: [{ createdAt: { lt: new Date(clock.now().getTime() - STUCK_RESCHEDULE_AFTER_MS) } }, { id: { in: failedIds } }],
  };
}

const include = { event: { select: { orgId: true, title: true } } } satisfies Prisma.EventRescheduleInclude;
type Row = Prisma.EventRescheduleGetPayload<{ include: typeof include }>;

async function toStuckReschedule(db: Tx, r: Row) {
  const [pendingOrders, failedOrders] = await Promise.all([
    db.order.count({ where: { pendingRescheduleId: r.id } }),
    db.order.count({ where: { pendingRescheduleId: r.id, rescheduleFailures: { gte: MAX_RESCHEDULE_FAILURES } } }),
  ]);
  return {
    id: r.id, orgId: r.event.orgId, eventId: r.eventId, eventTitle: r.event.title, oldStartsAt: iso(r.oldStartsAt), newStartsAt: iso(r.newStartsAt),
    reason: r.reason, createdAt: iso(r.createdAt), pendingOrders, failedOrders,
  };
}

export async function listStuckReschedules(page: number, pageSize: number) {
  const db = getDb();
  const where = await stuckWhere(db);
  const [rows, total] = await Promise.all([
    db.eventReschedule.findMany({ where, include, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], skip: (page - 1) * pageSize, take: pageSize }),
    db.eventReschedule.count({ where }),
  ]);
  return { items: await Promise.all(rows.map((r) => toStuckReschedule(db, r))), page, pageSize, total };
}

/** Relance : compteurs d'échecs des commandes du report remis à 0 ⇒ reprises au prochain passage du worker. */
export async function retryStuckReschedule(actorId: string, rescheduleId: string) {
  return transaction(async (tx) => {
    const r = await tx.eventReschedule.findFirst({ where: { id: rescheduleId, ...(await stuckWhere(tx)) }, include });
    if (!r) throw errors.notFound();
    const reset = await tx.order.updateMany({ where: { pendingRescheduleId: r.id, rescheduleFailures: { gt: 0 } }, data: { rescheduleFailures: 0 } });
    await writeAudit(tx, {
      orgId: r.event.orgId, actorId, action: 'event.reschedule_retry', target: `event:${r.eventId}`, meta: { rescheduleId: r.id, ordersReset: reset.count },
    });
    return toStuckReschedule(tx, r);
  });
}
