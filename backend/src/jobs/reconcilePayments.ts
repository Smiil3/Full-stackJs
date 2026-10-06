import { clock } from '../lib/clock.js';
import { getDb, transaction } from '../lib/db.js';
import { withTxRetry } from '../lib/txRetry.js';
import { getLogger } from '../lib/logger.js';
import { getPspClient } from '../lib/psp.js';
import { applySucceededPayment } from '../modules/payments/webhook.js';

/** Sessions consultées au plus par passage du worker (hors commandes arrivées à échéance). */
const RECENT_BATCH = 20;
/** Âge minimal d'une session, et délai entre deux consultations d'une même session. */
const RECHECK_MS = 60_000;
/** PSP injoignable : l'expiration d'une commande carte est différée au plus de ce délai après l'échéance. */
export const RECONCILE_GRACE_MS = 15 * 60_000;

export type ReconcileOutcome = 'paid' | 'unpaid' | 'unreachable';

/**
 * Rapprochement (contrat 1.15 §9, filet si un webhook a été perdu) : consulte HORS transaction chaque session
 * PSP de la commande ; une session `paid` est appliquée exactement comme un webhook reçu dans les délais
 * (le PSP refuse tout paiement après l'échéance de la session). Dédoublonné par l'identifiant du paiement :
 * le webhook arrivé ensuite est sans effet.
 */
export async function reconcileOrder(orderId: string): Promise<ReconcileOutcome> {
  const db = getDb();
  const sessions = await db.pspSession.findMany({ where: { orderId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
  let unreachable = false;
  for (const session of sessions) {
    let remote;
    try {
      remote = await getPspClient().getCheckoutSession(session.id);
    } catch (err) {
      unreachable = true;
      getLogger().warn({ err, orderId, sessionId: session.id }, 'rapprochement : PSP injoignable');
      continue;
    }
    await db.pspSession.update({ where: { id: session.id }, data: { checkedAt: clock.now() } });
    if (remote?.status !== 'paid' || remote.paymentId === null) continue;
    const data = { paymentId: remote.paymentId, orderId, amountCents: remote.amountCents, currency: remote.currency, sessionId: session.id };
    await withTxRetry(() => transaction((tx) => applySucceededPayment(tx, data, null)));
    getLogger().warn({ orderId, sessionId: session.id, paymentId: remote.paymentId }, 'paiement rapproché par consultation du PSP (webhook non reçu)');
    return 'paid';
  }
  return unreachable ? 'unreachable' : 'unpaid';
}

/** Job : sessions récentes des commandes carte encore en attente, consultées au plus une fois par minute. */
export async function reconcileRecentSessions(): Promise<{ checked: number; paid: number }> {
  const now = clock.now();
  const before = new Date(now.getTime() - RECHECK_MS);
  const rows = await getDb().$queryRaw<{ orderId: string }[]>`
    SELECT s."orderId"
    FROM "psp_sessions" s JOIN "orders" o ON o."id" = s."orderId"
    WHERE o."status" = 'PENDING_PAYMENT' AND o."expiresAt" > ${now}
      AND s."createdAt" <= ${before} AND (s."checkedAt" IS NULL OR s."checkedAt" <= ${before})
    GROUP BY s."orderId"
    ORDER BY MIN(COALESCE(s."checkedAt", s."createdAt")), s."orderId"
    LIMIT ${RECENT_BATCH}`;
  let paid = 0;
  for (const { orderId } of rows) {
    try {
      if ((await reconcileOrder(orderId)) === 'paid') paid += 1;
    } catch (err) {
      getLogger().error({ err, orderId }, 'échec du rapprochement d’une commande');
    }
  }
  return { checked: rows.length, paid };
}
