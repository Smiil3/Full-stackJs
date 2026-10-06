import Joi from 'joi';
import { cents, isoDateOutput, nullable, pageOf, pageQuery, uuid, uuidStrict, type PageQuery } from '../../lib/schemas.js';

export interface OrderItemInput { ticketTypeId: string; quantity: number }
export interface CreateOrderBody { eventId: string; paymentMethod: 'CARD' | 'TRANSFER'; items: OrderItemInput[] }

export const createOrderBody = Joi.object<CreateOrderBody>({
  eventId: uuid.required(),
  paymentMethod: Joi.string().valid('CARD', 'TRANSFER').required(),
  items: Joi.array()
    .items(Joi.object<OrderItemInput>({ ticketTypeId: uuid.required(), quantity: Joi.number().integer().min(1).max(20).required() }))
    .min(1).max(10).unique('ticketTypeId').required(),
});

export const idempotencyHeaders = Joi.object<{ 'idempotency-key': string }>({
  'idempotency-key': Joi.string().guid({ version: ['uuidv4', 'uuidv7'] }).lowercase().required()
    .messages({ 'any.required': 'L’en-tête Idempotency-Key (UUID) est obligatoire' }),
});

export const orderParams = Joi.object<{ orderId: string }>({ orderId: uuid.required() });
export const ordersQuery = Joi.object<PageQuery>(pageQuery);

const int = Joi.number().integer();
const transferInstructions = Joi.object({
  beneficiary: Joi.string(), iban: Joi.string(), bic: Joi.string(), reference: Joi.string(), amountCents: cents, deadline: isoDateOutput,
});

export const orderFields = {
  id: uuidStrict, eventId: uuidStrict, eventTitle: Joi.string(), eventStartsAt: isoDateOutput, eventTimezone: Joi.string(),
  status: Joi.string().valid('PENDING_PAYMENT', 'AWAITING_TRANSFER', 'PAID', 'EXPIRED', 'CANCELLED', 'REFUNDED'),
  paymentMethod: Joi.string().valid('CARD', 'TRANSFER'),
  items: Joi.array().items(Joi.object({ ticketTypeId: uuidStrict, name: Joi.string(), quantity: int, unitPriceCents: int })),
  subtotalCents: int, serviceFeeCents: int, totalCents: int, currency: Joi.string().valid('EUR'),
  expiresAt: nullable(isoDateOutput), paidAt: nullable(isoDateOutput), cancellableUntil: nullable(isoDateOutput),
  refundPercent: int, refundAmountCents: nullable(int), refundPreviewCents: nullable(int),
  createdAt: isoDateOutput, transferInstructions: nullable(transferInstructions),
};
export const orderResponse = Joi.object(orderFields);
export const orderPage = pageOf(orderResponse);
export const checkoutResponse = Joi.object({ redirectUrl: Joi.string().uri({ scheme: ['http', 'https'] }) });
