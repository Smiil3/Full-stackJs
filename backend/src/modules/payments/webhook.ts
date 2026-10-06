import Joi from 'joi';
import { getEnv } from '../../config/env.js';
import { transaction, type Tx } from '../../lib/db.js';
import { errors } from '../../lib/errors.js';
import { getLogger } from '../../lib/logger.js';
import { verifySignature } from '../../lib/pspSignature.js';
import { consumeQuota } from '../../lib/rateLimitStore.js';
import { loadOrderForUpdate, refundUnexpectedPayment, settleHeldOrder, settleLateHeldOrder, tryResettleExpiredOrder } from './settle.js';
import { clock } from '../../lib/clock.js';
import { PSP_ID_MAX_LENGTH, WEBHOOK_MAX_AMOUNT_CENTS, WEBHOOK_TYPE_MAX_LENGTH, WEBHOOK_TYPE_STORED_LENGTH } from '../../config/payments.js';
import { QUOTAS } from '../../config/rateLimits.js';
import { fromUnixSeconds } from '../../config/units.js';

interface PspEnvelope {
  id: string;
  type: string;
  created: number;
  data: Record<string, unknown>;
}

/** Enveloppe : seuls les champs utilisés sont validés ; les champs inconnus de `data` sont tolérés. */
const envelopeSchema = Joi.object<PspEnvelope>({
  id: Joi.string().pattern(/^evt_[A-Za-z0-9_-]{1,64}$/).required(),
  type: Joi.string().max(WEBHOOK_TYPE_MAX_LENGTH).required(),
  created: Joi.number().integer().min(0).required(),
  data: Joi.object().unknown(true).required(),
}).unknown(true);

export interface PaymentData {
  paymentId: string;
  orderId: string;
  amountCents: number;
  currency: string;
  sessionId?: string;
}

const paymentDataSchema = Joi.object<PaymentData>({
  paymentId: Joi.string().pattern(/^pay_[A-Za-z0-9_-]{1,64}$/).required(),
  orderId: Joi.string().max(PSP_ID_MAX_LENGTH).required(),
  amountCents: Joi.number().integer().min(0).max(WEBHOOK_MAX_AMOUNT_CENTS).required(),
  currency: Joi.string().pattern(/^[A-Z]{3}$/).required(),
  sessionId: Joi.string().max(PSP_ID_MAX_LENGTH),
}).unknown(true);

const refundDataSchema = Joi.object<{ refundId?: string; paymentId: string; idempotencyKey?: string }>({
  refundId: Joi.string().pattern(/^re_[A-Za-z0-9_-]{1,64}$/),
  idempotencyKey: Joi.string().max(PSP_ID_MAX_LENGTH),
  paymentId: Joi.string().max(PSP_ID_MAX_LENGTH).required(),
}).unknown(true);

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function parseEnvelope(raw: Buffer): PspEnvelope | null {
  let json: unknown;
  try {
    json = JSON.parse(raw.toString('utf8'), (key: string, value: unknown) => {
      if (FORBIDDEN_KEYS.has(key)) throw new SyntaxError('clé interdite');
      return value;
    });
  } catch {
    throw errors.validation([{ path: 'body', message: 'JSON invalide.' }]);
  }
  const result = envelopeSchema.validate(json, { convert: false });
  // JSON signé mais enveloppe inexploitable (sans identifiant…) : on ne peut ni dédoublonner ni traiter.
  // Contrat : 200 (le PSP ne doit pas réessayer indéfiniment), alerte journalisée pour traitement manuel.
  if (result.error) return null;
  return result.value;
}

/**
 * Webhook PSP (contrat 1.10 §9) :
 * - 400 UNIQUEMENT pour une signature invalide / un horodatage hors tolérance / un corps non JSON ;
 * - une fois la signature valide : 200 dans TOUS les cas métier — un paiement authentifié n'est jamais perdu :
 *   toute somme encaissée qui ne donne pas de billets est enregistrée puis remboursée automatiquement ;
 * - l'événement (providerEventId UNIQUE) est inséré dans la même transaction que son effet (idempotence).
 * Une 5xx ne survient que sur panne réelle (le PSP réessaiera).
 */
export async function handlePspWebhook(raw: Buffer, signature: string | undefined, ip: string): Promise<{ received: true }> {
  const check = verifySignature(getEnv().psp.webhookSecret, signature, raw);
  if (!check.ok) {
    getLogger().warn({ reason: check.reason }, 'webhook PSP refusé');
    // Seules les signatures invalides sont comptées : une notification signée n'est jamais refusée pour débit.
    await consumeQuota('webhook-invalid', ip, QUOTAS.webhookInvalid.windowMs, QUOTAS.webhookInvalid.max);
    throw errors.validation([{ path: 'Psp-Signature', message: check.reason === 'timestamp' ? 'Horodatage hors tolérance.' : 'Signature invalide.' }], 'Signature invalide.');
  }
  const event = parseEnvelope(raw);
  if (!event) {
    getLogger().error({ size: raw.length }, 'événement PSP signé mais enveloppe inexploitable : intervention manuelle requise');
    return { received: true };
  }
  await transaction(async (tx) => {
    const inserted = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO "webhook_events" ("id", "providerEventId", "type", "receivedAt")
      VALUES (gen_random_uuid(), ${event.id}, ${event.type.slice(0, WEBHOOK_TYPE_STORED_LENGTH)}, ${clock.now()})
      ON CONFLICT ("providerEventId") DO NOTHING
      RETURNING "id"`;
    // Doublon : déjà traité (ou en cours dans une transaction concurrente qui a la priorité).
    const webhookRowId = inserted[0]?.id;
    if (!webhookRowId) return;
    switch (event.type) {
      case 'payment.succeeded':
        await onPaymentSucceeded(tx, event);
        break;
      case 'payment.failed':
        await onPaymentFailed(tx, event);
        break;
      case 'refund.succeeded':
        await onRefundSucceeded(tx, event);
        break;
      default:
        getLogger().warn({ eventId: event.id, type: event.type }, 'type d’événement PSP non géré : ignoré');
    }
    await tx.webhookEvent.update({ where: { id: webhookRowId }, data: { processedAt: clock.now() } });
  });
  return { received: true };
}

function paymentData(event: PspEnvelope): PaymentData | null {
  const result = paymentDataSchema.validate(event.data, { convert: false });
  if (result.error) {
    getLogger().error({ eventId: event.id, type: event.type }, 'événement de paiement signé mais inexploitable : intervention manuelle requise');
    return null;
  }
  return result.value;
}

async function onPaymentSucceeded(tx: Tx, event: PspEnvelope): Promise<void> {
  const data = paymentData(event);
  if (!data) return;
  // L'horodatage signé du PSP dit si le paiement a eu lieu avant ou après l'échéance de la commande.
  await applySucceededPayment(tx, data, new Date(fromUnixSeconds(event.created)));
}

/**
 * Paiement réussi (webhook ou rapprochement) : billets, ou enregistrement + remboursement automatique.
 * `paidAt` null ⇒ paiement réputé dans les délais (session consultée : le PSP refuse tout paiement après l'échéance).
 */
export async function applySucceededPayment(tx: Tx, data: PaymentData, paidAt: Date | null): Promise<void> {
  // Commande verrouillée AVANT la recherche du paiement : webhook et rapprochement simultanés sont sérialisés.
  const order = UUID_RE.test(data.orderId) ? await loadOrderForUpdate(tx, data.orderId) : null;
  // Un paiement d'abord signalé en échec puis réussi (même paymentId) est traité normalement.
  const existing = await tx.payment.findUnique({ where: { providerPaymentId: data.paymentId } });
  if (existing?.status === 'SUCCEEDED') return;
  const paymentFields = { amountCents: data.amountCents, currency: data.currency, status: 'SUCCEEDED' as const, orderId: order?.id ?? null };
  const payment = existing
    ? await tx.payment.update({ where: { id: existing.id }, data: paymentFields })
    : await tx.payment.create({ data: { providerPaymentId: data.paymentId, ...paymentFields } });

  if (!order) {
    await refundUnexpectedPayment(tx, null, payment, 'UNEXPECTED_PAYMENT', 'commande inconnue');
    return;
  }
  // Toute session ouverte pour la commande reste valable (historique) : un refus suivi d'un succès sur la même
  // session n'est pas remboursé à tort ; une session d'une autre commande, si.
  const knownSession = data.sessionId !== undefined
    && (await tx.pspSession.count({ where: { id: data.sessionId, orderId: order.id } })) === 1;
  const mismatch =
    data.currency !== order.currency ? 'devise incohérente'
    : data.amountCents !== order.totalCents ? 'montant incohérent'
    : order.paymentMethod !== 'CARD' ? 'commande non payable par carte'
    : !knownSession ? 'session de paiement inconnue pour cette commande'
    : null;
  // Événement annulé : un paiement d'une commande non payée n'aboutira jamais à des billets ⇒ remboursé.
  if (order.event.status === 'CANCELLED' && order.status !== 'PAID') {
    await refundUnexpectedPayment(tx, order, payment, 'EVENT_CANCELLED', 'événement annulé');
    return;
  }
  if (mismatch && order.status !== 'PAID') {
    await refundUnexpectedPayment(tx, order, payment, 'UNEXPECTED_PAYMENT', mismatch);
    return;
  }
  switch (order.status) {
    case 'PENDING_PAYMENT': {
      const late = paidAt !== null && order.expiresAt !== null && paidAt > order.expiresAt;
      if (!late) {
        if (!(await settleHeldOrder(tx, order, 'PENDING_PAYMENT'))) {
          await refundUnexpectedPayment(tx, order, payment, 'UNEXPECTED_PAYMENT', 'stock bloqué incohérent');
        }
        return;
      }
      // Échéance dépassée mais le worker n'est pas encore passé : mêmes règles qu'un paiement tardif.
      const outcome = await settleLateHeldOrder(tx, order, 'PENDING_PAYMENT');
      if (outcome === 'refused') await refundUnexpectedPayment(tx, order, payment, 'LATE_PAYMENT', 'paiement après l’échéance, règles de vente non respectées');
      if (outcome === 'inconsistent') await refundUnexpectedPayment(tx, order, payment, 'UNEXPECTED_PAYMENT', 'stock bloqué incohérent');
      return;
    }
    case 'EXPIRED':
      if (!(await tryResettleExpiredOrder(tx, order))) await refundUnexpectedPayment(tx, order, payment, 'LATE_PAYMENT', 'paiement après expiration, règles de vente non respectées');
      return;
    case 'PAID':
      await refundUnexpectedPayment(tx, order, payment, 'DUPLICATE_PAYMENT', 'commande déjà payée');
      return;
    default:
      await refundUnexpectedPayment(tx, order, payment, 'UNEXPECTED_PAYMENT', `commande ${order.status}`);
  }
}

async function onPaymentFailed(tx: Tx, event: PspEnvelope): Promise<void> {
  const data = paymentData(event);
  if (!data) return;
  const order = UUID_RE.test(data.orderId) ? await loadOrderForUpdate(tx, data.orderId) : null;
  if (!(await tx.payment.findUnique({ where: { providerPaymentId: data.paymentId } }))) {
    await tx.payment.create({
      data: { providerPaymentId: data.paymentId, orderId: order?.id ?? null, amountCents: data.amountCents, currency: data.currency, status: 'FAILED' },
    });
  }
  // Session refusée : oubliée, pour qu'une nouvelle tentative ouvre une nouvelle session (clé d'idempotence suivante).
  if (order?.status === 'PENDING_PAYMENT' && data.sessionId && data.sessionId === order.pspSessionId) {
    await tx.order.updateMany({
      where: { id: order.id, status: 'PENDING_PAYMENT', pspSessionId: data.sessionId },
      data: { pspSessionId: null, pspSessionUrl: null, checkoutAttempt: { increment: 1 } },
    });
  }
}

async function onRefundSucceeded(tx: Tx, event: PspEnvelope): Promise<void> {
  const result = refundDataSchema.validate(event.data, { convert: false });
  const value = result.error ? undefined : result.value;
  const refundId = value?.refundId;
  if (!refundId) {
    getLogger().warn({ eventId: event.id }, 'refund.succeeded sans identifiant de remboursement : ignoré');
    return;
  }
  // Clé d'idempotence = id de notre remboursement : rapproche aussi un remboursement dont la réponse PSP a été perdue.
  const key = value.idempotencyKey;
  const ownId = key !== undefined && UUID_RE.test(key) ? key : null;
  // Appariement par identifiant (jamais par montant) ; un succès tardif régularise aussi un MANUAL_REQUIRED / FAILED.
  const { count } = await tx.refund.updateMany({
    where: {
      OR: ownId ? [{ providerRefundId: refundId }, { id: ownId, providerRefundId: null }] : [{ providerRefundId: refundId }],
      status: { in: ['PENDING', 'MANUAL_REQUIRED', 'FAILED'] },
    },
    data: { status: 'SUCCEEDED', providerRefundId: refundId },
  });
  if (count === 0 && !(await tx.refund.findUnique({ where: { providerRefundId: refundId } }))) {
    getLogger().warn({ eventId: event.id, refundId }, 'refund.succeeded pour un remboursement inconnu');
  }
}
