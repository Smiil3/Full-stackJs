import type { Prisma } from '../../generated/prisma/client.js';
import { writeAudit } from '../../lib/audit.js';
import { clock } from '../../lib/clock.js';
import { getDb, transaction, type Tx } from '../../lib/db.js';
import { AppError, errors } from '../../lib/errors.js';
import { orderInclude, scannedCounts } from '../orders/repo.js';
import { toOrderView } from '../orders/service.js';
import { loadOrderForUpdate, settleHeldOrder, settleLateHeldOrder, tryResettleExpiredOrder } from '../payments/settle.js';
import type { EventOrdersQuery } from './schemas.js';

const adminInclude = { ...orderInclude, user: { select: { id: true, email: true, displayName: true } } } satisfies Prisma.OrderInclude;
type AdminOrder = Prisma.OrderGetPayload<{ include: typeof adminInclude }>;

function toOrderAdmin(order: AdminOrder, scanned: number, now: Date) {
  return { ...toOrderView(order, scanned, 'admin', now), buyer: { id: order.user.id, email: order.user.email, displayName: order.user.displayName } };
}

/** Commandes d'un événement du collectif (MANAGER+) : orgId dans le filtre, recherche par email. */
export async function listEventOrders(orgId: string, eventId: string, query: EventOrdersQuery) {
  const db = getDb();
  const event = await db.event.findFirst({ where: { id: eventId, orgId }, select: { id: true } });
  if (!event) throw errors.notFound();
  const where: Prisma.OrderWhereInput = {
    eventId,
    event: { orgId },
    ...(query.status ? { status: query.status } : {}),
    // Jokers LIKE (% et _) échappés : la recherche porte sur le texte saisi, pas sur un motif.
    ...(query.q ? { user: { email: { contains: query.q.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`) } } } : {}),
  };
  const [rows, total] = await Promise.all([
    db.order.findMany({ where, include: adminInclude, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
    db.order.count({ where }),
  ]);
  const scanned = await scannedCounts(db, rows.map((o) => o.id));
  const now = clock.now();
  return { items: rows.map((o) => toOrderAdmin(o, scanned.get(o.id) ?? 0, now)), page: query.page, pageSize: query.pageSize, total };
}

async function loadAdminOrder(tx: Tx, orgId: string, orderId: string) {
  const order = await tx.order.findFirst({ where: { id: orderId, event: { orgId } }, include: adminInclude });
  if (!order) throw errors.notFound();
  return order;
}

/**
 * Validation manuelle d'un virement (MANAGER+) : commande du collectif, en attente de virement,
 * montant reçu EXACTEMENT égal au montant dû ; billets émis, mail, audit.
 */
export async function confirmTransfer(orgId: string, actorId: string, orderId: string, receivedAmountCents: number) {
  return transaction(async (tx) => {
    // Appartenance vérifiée AVANT tout verrou ou effet.
    await loadAdminOrder(tx, orgId, orderId);
    const order = await loadOrderForUpdate(tx, orderId);
    if (!order || order.event.orgId !== orgId) throw errors.notFound();
    if (order.event.status !== 'PUBLISHED') throw errors.state('SALES_CLOSED', 'L’événement n’est plus en vente.');
    const expiredError = () => errors.state('ORDER_EXPIRED', 'La réservation a expiré : les places ne sont plus disponibles.');
    if (order.paymentMethod !== 'TRANSFER' || (order.status !== 'AWAITING_TRANSFER' && order.status !== 'EXPIRED')) {
      throw errors.state('INVALID_STATE', 'Cette commande n’attend pas de virement.');
    }
    // L'échéance fait foi, pas le passage du worker d'expiration.
    const late = order.status === 'EXPIRED' || (order.expiresAt !== null && order.expiresAt <= clock.now());
    if (receivedAmountCents !== order.totalCents) {
      throw errors.unprocessable('AMOUNT_MISMATCH', 'Le montant reçu ne correspond pas au montant dû.', { expectedCents: order.totalCents, receivedCents: receivedAmountCents });
    }
    await tx.payment.create({
      data: { orderId: order.id, providerPaymentId: `transfer:${order.id}`, amountCents: receivedAmountCents, currency: 'EUR', status: 'SUCCEEDED' },
    });
    // Virement reçu après l'échéance : repris seulement si toutes les règles de vente tiennent encore (contrat §4) ;
    // sinon rien n'est enregistré (ORDER_EXPIRED) et le collectif rembourse le virement.
    if (order.status === 'EXPIRED') {
      if (!(await tryResettleExpiredOrder(tx, order))) throw expiredError();
    } else if (late) {
      const outcome = await settleLateHeldOrder(tx, order, 'AWAITING_TRANSFER');
      if (outcome === 'refused') throw expiredError();
      if (outcome === 'inconsistent') throw new AppError(409, 'CONFLICT', 'Stock incohérent pour cette commande : contactez le support.');
    } else if (!(await settleHeldOrder(tx, order, 'AWAITING_TRANSFER'))) {
      throw new AppError(409, 'CONFLICT', 'Stock incohérent pour cette commande : contactez le support.');
    }
    await writeAudit(tx, {
      orgId, actorId, action: 'order.confirm_transfer', target: `order:${order.id}`,
      meta: { amountCents: receivedAmountCents, reference: order.transferReference },
    });
    const updated = await loadAdminOrder(tx, orgId, orderId);
    return toOrderAdmin(updated, 0, clock.now());
  });
}
