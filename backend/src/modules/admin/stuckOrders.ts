import type { Prisma } from '../../generated/prisma/client.js';
import { MAX_EXPIRE_FAILURES } from '../../config/worker.js';
import { writeAudit } from '../../lib/audit.js';
import { getDb, transaction } from '../../lib/db.js';
import { errors } from '../../lib/errors.js';
import { iso } from '../../lib/schemas.js';

/** Commandes en attente écartées de l'expiration automatique après MAX_EXPIRE_FAILURES échecs (contrat 1.17 §8, audit B2). */
const stuckWhere: Prisma.OrderWhereInput = {
  status: { in: ['PENDING_PAYMENT', 'AWAITING_TRANSFER'] }, expireFailures: { gte: MAX_EXPIRE_FAILURES },
};
const include = { user: { select: { email: true } }, event: { select: { orgId: true, title: true } } } satisfies Prisma.OrderInclude;
type StuckRow = Prisma.OrderGetPayload<{ include: typeof include }>;

function toStuckOrder(o: StuckRow) {
  return {
    id: o.id, orgId: o.event.orgId, eventId: o.eventId, eventTitle: o.event.title, buyerEmail: o.user.email,
    status: o.status, paymentMethod: o.paymentMethod, totalCents: o.totalCents, expiresAt: iso(o.expiresAt),
    expireFailures: o.expireFailures, createdAt: iso(o.createdAt),
  };
}

export async function listStuckOrders(page: number, pageSize: number) {
  const db = getDb();
  const [rows, total] = await Promise.all([
    db.order.findMany({ where: stuckWhere, include, orderBy: [{ expiresAt: 'asc' }, { id: 'asc' }], skip: (page - 1) * pageSize, take: pageSize }),
    db.order.count({ where: stuckWhere }),
  ]);
  return { items: rows.map(toStuckOrder), page, pageSize, total };
}

/** Relance : compteur d'échecs remis à 0 ⇒ la commande est reprise au prochain passage du worker. */
export async function retryStuckOrder(actorId: string, orderId: string) {
  return transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "orders" WHERE "id" = ${orderId}::uuid FOR UPDATE`;
    const order = rows.length === 1 ? await tx.order.findFirst({ where: { id: orderId, ...stuckWhere }, include }) : null;
    if (!order) throw errors.notFound();
    const updated = await tx.order.update({ where: { id: orderId }, data: { expireFailures: 0 }, include });
    await writeAudit(tx, {
      orgId: order.event.orgId, actorId, action: 'order.expire_retry', target: `order:${orderId}`, meta: { expireFailures: order.expireFailures },
    });
    return toStuckOrder(updated);
  });
}
