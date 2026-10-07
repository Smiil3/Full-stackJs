import type { Prisma } from '../../generated/prisma/client.js';
import { writeAudit } from '../../lib/audit.js';
import { getDb, transaction } from '../../lib/db.js';
import { errors } from '../../lib/errors.js';
import { getLogger } from '../../lib/logger.js';
import { getPspClient, isPspUnavailable } from '../../lib/psp.js';
import { iso } from '../../lib/schemas.js';
import type { RefundsQuery } from './schemas.js';

const include = {
  order: { select: { id: true, paymentMethod: true, user: { select: { email: true } }, event: { select: { id: true, title: true } } } },
  payment: { select: { providerPaymentId: true } },
} satisfies Prisma.RefundInclude;
type RefundWithOrder = Prisma.RefundGetPayload<{ include: typeof include }>;

/** Virement ⇒ identifiant de paiement « transfer:… » ; tout autre paiement est passé par le PSP (carte). */
const methodOf = (r: RefundWithOrder): 'CARD' | 'TRANSFER' =>
  r.order?.paymentMethod ?? (r.payment.providerPaymentId.startsWith('transfer:') ? 'TRANSFER' : 'CARD');

function toRefundAdmin(r: RefundWithOrder) {
  const order = r.order;
  return {
    id: r.id, orderId: order?.id ?? null, eventId: order?.event.id ?? null, eventTitle: order?.event.title ?? null,
    // Paiement inattendu sans commande : le PSP simulé ne transmet pas d'email (contrat §8 : null si inconnu).
    buyerEmail: order?.user.email ?? null,
    amountCents: r.amountCents, reason: r.reason, method: methodOf(r), status: r.status, note: r.note,
    createdAt: iso(r.createdAt), updatedAt: iso(r.updatedAt),
  };
}

async function page(where: Prisma.RefundWhereInput, query: RefundsQuery) {
  const db = getDb();
  const [rows, total] = await Promise.all([
    db.refund.findMany({ where, include, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
    db.refund.count({ where }),
  ]);
  return { items: rows.map(toRefundAdmin), page: query.page, pageSize: query.pageSize, total };
}

/** Remboursements des commandes du collectif (orgId dans le filtre via la commande). */
export function listRefunds(orgId: string, query: RefundsQuery) {
  return page({
    order: { event: { orgId, ...(query.eventId ? { id: query.eventId } : {}) } },
    ...(query.status ? { status: query.status } : {}),
  }, query);
}

/** Admin plateforme (contrat 1.17 §8) : remboursements SANS commande rattachée (paiements inattendus), visibles de personne d'autre. */
export function listOrphanRefunds(query: RefundsQuery) {
  return page({ orderId: null, ...(query.status ? { status: query.status } : {}) }, query);
}

type Scope = { kind: 'org'; orgId: string } | { kind: 'platform' };

const scopeWhere = (scope: Scope): Prisma.RefundWhereInput =>
  scope.kind === 'org' ? { order: { event: { orgId: scope.orgId } } } : { orderId: null };

/**
 * Remboursement déclaré effectué à la main (contrat 1.17 §7.3 bis) : MANUAL_REQUIRED / FAILED ⇒ SUCCEEDED, tracé.
 * Carte : le PSP est interrogé d'abord, HORS transaction (clé d'idempotence = id du remboursement) —
 * déjà remboursé ⇒ SUCCEEDED automatique (note conservée) ; en cours ⇒ 409 (ne pas rembourser une 2e fois) ;
 * injoignable ⇒ 503. Inconnu du PSP ou refusé ⇒ remboursement manuel accepté.
 */
async function markDoneIn(scope: Scope, actorId: string, refundId: string, note: string) {
  const found = await getDb().refund.findFirst({ where: { id: refundId, ...scopeWhere(scope) }, include });
  if (!found) throw errors.notFound();
  if (found.status !== 'MANUAL_REQUIRED' && found.status !== 'FAILED') {
    throw errors.state('INVALID_STATE', 'Ce remboursement n’est pas à traiter manuellement.');
  }
  let psp: { id: string; status: string } | null = null;
  if (methodOf(found) === 'CARD') {
    try {
      psp = await getPspClient().findRefund(refundId);
    } catch (err) {
      if (!isPspUnavailable(err)) throw err;
      getLogger().warn({ err, refundId }, 'mark-done : prestataire de paiement injoignable');
      throw errors.paymentProviderUnavailable();
    }
    if (psp?.status === 'pending') {
      throw errors.state('INVALID_STATE', 'Remboursement en cours chez le prestataire : ne pas rembourser à la main.');
    }
  }
  const pspDone = psp?.status === 'succeeded';
  return transaction(async (tx) => {
    const { count } = await tx.refund.updateMany({
      where: { id: refundId, status: { in: ['MANUAL_REQUIRED', 'FAILED'] } },
      data: { status: 'SUCCEEDED', note, ...(pspDone && psp ? { providerRefundId: psp.id } : {}) },
    });
    if (count !== 1) throw errors.state('INVALID_STATE', 'Ce remboursement n’est pas à traiter manuellement.');
    await writeAudit(tx, {
      orgId: scope.kind === 'org' ? scope.orgId : null, actorId, action: 'refund.mark_done', target: `refund:${refundId}`,
      meta: { amountCents: found.amountCents, from: found.status, note, verifiedByPsp: pspDone },
    });
    return toRefundAdmin(await tx.refund.findUniqueOrThrow({ where: { id: refundId }, include }));
  });
}

export const markDone = (orgId: string, actorId: string, refundId: string, note: string) =>
  markDoneIn({ kind: 'org', orgId }, actorId, refundId, note);

export const markOrphanDone = (actorId: string, refundId: string, note: string) =>
  markDoneIn({ kind: 'platform' }, actorId, refundId, note);
