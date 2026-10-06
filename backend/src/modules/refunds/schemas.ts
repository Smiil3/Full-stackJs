import Joi from 'joi';
import { isoDateOutput, nullable, pageOf, pageQuery, text, uuid, uuidStrict, type PageQuery } from '../../lib/schemas.js';

export const REFUND_STATUSES = ['PENDING', 'SUCCEEDED', 'MANUAL_REQUIRED', 'FAILED'] as const;
export type RefundStatusName = (typeof REFUND_STATUSES)[number];

export interface RefundsQuery extends PageQuery { status?: RefundStatusName; eventId?: string }
export const refundsQuery = Joi.object<RefundsQuery>({ ...pageQuery, status: Joi.string().valid(...REFUND_STATUSES), eventId: uuid });
export const orgParams = Joi.object<{ orgId: string }>({ orgId: uuid.required() });
export const refundParams = Joi.object<{ orgId: string; refundId: string }>({ orgId: uuid.required(), refundId: uuid.required() });
export const markDoneBody = Joi.object<{ note: string }>({ note: text({ multiline: true }).min(1).max(500).required() });

export const refundAdminResponse = Joi.object({
  id: uuidStrict, orderId: uuidStrict, eventId: uuidStrict, eventTitle: Joi.string(), buyerEmail: Joi.string(), amountCents: Joi.number().integer(),
  reason: Joi.string().valid('SELF_CANCELLATION', 'EVENT_CANCELLED', 'LATE_PAYMENT', 'DUPLICATE_PAYMENT', 'UNEXPECTED_PAYMENT'),
  method: Joi.string().valid('CARD', 'TRANSFER'), status: Joi.string().valid(...REFUND_STATUSES), note: nullable(Joi.string()),
  createdAt: isoDateOutput, updatedAt: isoDateOutput,
});
export const refundAdminPage = pageOf(refundAdminResponse);
