import Joi from 'joi';
import { getEnv } from '../../config/env.js';
import { transaction } from '../../lib/db.js';
import { AppError, errors } from '../../lib/errors.js';
import { getLogger } from '../../lib/logger.js';
import { verifySignature } from '../../lib/pspSignature.js';
import { loadOrderForUpdate, refundUnexpectedPayment, settleHeldOrder, tryResettleExpiredOrder } from './settle.js';

interface PspEvent {
  id: string;
  type: 'payment.succeeded' | 'payment.failed' | 'refund.succeeded';
  created: number;
  data: { paymentId: string; sessionId?: string; orderId: string; amountCents: number; currency: string };
}

const eventSchema = Joi.object<PspEvent>({
  id: Joi.string().pattern(/^evt_[A-Za-z0-9_-]{1,64}$/).required(),
  type: Joi.string().valid('payment.succeeded', 'payment.failed', 'refund.succeeded').required(),
  created: Joi.number().integer().min(0).required(),
  data: Joi.object({
    paymentId: Joi.string().pattern(/^pay_[A-Za-z0-9_-]{1,64}$/).required(),
    sessionId: Joi.string().pattern(/^cs_[A-Za-z0-9_-]{1,64}$/),
    orderId: Joi.string().guid().required(),
    amountCents: Joi.number().integer().min(0).max(100_000_000).required(),
    currency: Joi.string().length(3).required(),
  }).required(),
});

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function parseEvent(raw: Buffer): PspEvent {
  let json: unknown;
  try {
    json = JSON.parse(raw.toString('utf8'), (key: string, value: unknown) => {
      if (FORBIDDEN_KEYS.has(key)) throw new SyntaxError('clé interdite');
      return value;
    });
  } catch {
    throw errors.validation([{ path: 'body', message: 'JSON invalide.' }]);
  }
  const result = eventSchema.validate(json, { allowUnknown: false, convert: false });
  if (result.error) throw errors.validation([{ path: 'body', message: 'Événement PSP invalide.' }]);
  return result.value;
}

/** Rejet sans effet : la transaction est annulée (y compris l'enregistrement de l'événement). */
class WebhookRejected extends AppError {
  constructor(message: string) {
    super(400, 'VALIDATION_ERROR', message);
  }
}

/**
 * Webhook PSP, idempotent :
 * 1. signature HMAC sur les octets bruts + horodatage ±5 min ;
 * 2. INSERT de l'événement (providerEventId UNIQUE) DANS LA MÊME TRANSACTION que l'effet :
 *    un doublon (séquentiel ou concurrent) ne produit aucun effet et reçoit 200 ;
 * 3. vérification commande + montant + devise ; transitions gardées par le statut.
 */
export async function handlePspWebhook(raw: Buffer, signature: string | undefined): Promise<{ received: true }> {
  const check = verifySignature(getEnv().psp.webhookSecret, signature, raw);
  if (!check.ok) {
    getLogger().warn({ reason: check.reason }, 'webhook PSP refusé');
    throw errors.validation([{ path: 'Psp-Signature', message: check.reason === 'timestamp' ? 'Horodatage hors tolérance.' : 'Signature invalide.' }], 'Signature invalide.');
  }
  const event = parseEvent(raw);
  await transaction(async (tx) => {
    const inserted = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO "webhook_events" ("id", "providerEventId", "type", "receivedAt")
      VALUES (gen_random_uuid(), ${event.id}, ${event.type}, now())
      ON CONFLICT ("providerEventId") DO NOTHING
      RETURNING "id"`;
    // Doublon : déjà traité (ou en cours dans une transaction concurrente qui a la priorité).
    if (inserted.length === 0) return;
    const webhookRowId = inserted[0]?.id;

    if (event.type === 'refund.succeeded') {
      const refund = await tx.refund.findFirst({
        where: { payment: { providerPaymentId: event.data.paymentId }, amountCents: event.data.amountCents, status: 'PENDING' },
        orderBy: { createdAt: 'asc' },
      });
      if (refund) await tx.refund.updateMany({ where: { id: refund.id, status: 'PENDING' }, data: { status: 'SUCCEEDED' } });
    } else if (event.type === 'payment.succeeded') {
      const order = await loadOrderForUpdate(tx, event.data.orderId);
      if (!order) {
        getLogger().error({ eventId: event.id }, 'paiement reçu pour une commande inconnue');
        throw new WebhookRejected('Commande inconnue.');
      }
      if (event.data.currency !== order.currency || event.data.amountCents !== order.totalCents) {
        getLogger().error({ eventId: event.id, orderId: order.id }, 'paiement au montant ou à la devise incohérents');
        throw new WebhookRejected('Montant ou devise incohérents.');
      }
      if (await tx.payment.findUnique({ where: { providerPaymentId: event.data.paymentId } })) return;
      const payment = await tx.payment.create({
        data: { orderId: order.id, providerPaymentId: event.data.paymentId, amountCents: event.data.amountCents, currency: event.data.currency, status: 'SUCCEEDED' },
      });
      if (order.status === 'PENDING_PAYMENT') {
        await settleHeldOrder(tx, order, 'PENDING_PAYMENT');
      } else if (order.status === 'EXPIRED') {
        if (!(await tryResettleExpiredOrder(tx, order))) await refundUnexpectedPayment(tx, order, payment, 'LATE_PAYMENT');
      } else if (order.status === 'PAID') {
        await refundUnexpectedPayment(tx, order, payment, 'DUPLICATE_PAYMENT');
      } else {
        // Annulée, remboursée, en attente de virement : paiement non attendu ⇒ remboursé.
        await refundUnexpectedPayment(tx, order, payment, 'UNEXPECTED_PAYMENT');
      }
    } else {
      // payment.failed : la commande reste en attente (l'acheteur peut réessayer) ; trace conservée.
      const order = await tx.order.findUnique({ where: { id: event.data.orderId }, select: { id: true } });
      if (order && !(await tx.payment.findUnique({ where: { providerPaymentId: event.data.paymentId } }))) {
        await tx.payment.create({
          data: { orderId: order.id, providerPaymentId: event.data.paymentId, amountCents: event.data.amountCents, currency: 'EUR', status: 'FAILED' },
        });
      }
    }
    if (webhookRowId) await tx.webhookEvent.update({ where: { id: webhookRowId }, data: { processedAt: new Date() } });
  });
  return { received: true };
}
