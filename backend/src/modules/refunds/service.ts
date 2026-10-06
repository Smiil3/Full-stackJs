import type { Prisma } from '../../generated/prisma/client.js';
import { writeAudit } from '../../lib/audit.js';
import { getDb, transaction } from '../../lib/db.js';
import { errors } from '../../lib/errors.js';
import { iso } from '../../lib/schemas.js';
import type { RefundsQuery } from './schemas.js';

const include = {
  order: { select: { id: true, paymentMethod: true, user: { select: { email: true } }, event: { select: { id: true, title: true } } } },
} satisfies Prisma.RefundInclude;
type RefundWithOrder = Prisma.RefundGetPayload<{ include: typeof include }>;

function toRefundAdmin(r: RefundWithOrder) {
  const order = r.order;
  if (!order) throw errors.notFound();
  return {
    id: r.id, orderId: order.id, eventId: order.event.id, eventTitle: order.event.title, buyerEmail: order.user.email,
    amountCents: r.amountCents, reason: r.reason, method: order.paymentMethod, status: r.status, note: r.note,
    createdAt: iso(r.createdAt), updatedAt: iso(r.updatedAt),
  };
}

/** Remboursements des commandes du collectif (orgId dans le filtre via la commande). */
export async function listRefunds(orgId: string, query: RefundsQuery) {
  const where: Prisma.RefundWhereInput = {
    order: { event: { orgId, ...(query.eventId ? { id: query.eventId } : {}) } },
    ...(query.status ? { status: query.status } : {}),
  };
  const db = getDb();
  const [rows, total] = await Promise.all([
    db.refund.findMany({ where, include, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
    db.refund.count({ where }),
  ]);
  return { items: rows.map(toRefundAdmin), page: query.page, pageSize: query.pageSize, total };
}

/** Remboursement effectué hors PSP (virement retour…) : MANUAL_REQUIRED / FAILED ⇒ SUCCEEDED, tracé. */
export async function markDone(orgId: string, actorId: string, refundId: string, note: string) {
  return transaction(async (tx) => {
    const refund = await tx.refund.findFirst({ where: { id: refundId, order: { event: { orgId } } }, include });
    if (!refund) throw errors.notFound();
    const { count } = await tx.refund.updateMany({
      where: { id: refundId, status: { in: ['MANUAL_REQUIRED', 'FAILED'] } },
      data: { status: 'SUCCEEDED', note },
    });
    if (count !== 1) throw errors.state('INVALID_STATE', 'Ce remboursement n’est pas à traiter manuellement.');
    await writeAudit(tx, { orgId, actorId, action: 'refund.mark_done', target: `refund:${refundId}`, meta: { amountCents: refund.amountCents, from: refund.status, note } });
    const updated = await tx.refund.findUniqueOrThrow({ where: { id: refundId }, include });
    return toRefundAdmin(updated);
  });
}
