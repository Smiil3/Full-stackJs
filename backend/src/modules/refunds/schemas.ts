import Joi from 'joi';
import { isoDateOutput, nullable, pageOf, pageQuery, text, uuid, uuidStrict, type PageQuery } from '../../lib/schemas.js';
import { FIELD_LIMITS } from '../../config/fields.js';

export const REFUND_STATUSES = ['PENDING', 'SUCCEEDED', 'MANUAL_REQUIRED', 'FAILED'] as const;
export type RefundStatusName = (typeof REFUND_STATUSES)[number];

export interface RefundsQuery extends PageQuery { status?: RefundStatusName; eventId?: string }
export const refundsQuery = Joi.object<RefundsQuery>({ ...pageQuery, status: Joi.string().valid(...REFUND_STATUSES), eventId: uuid });
export const orgParams = Joi.object<{ orgId: string }>({ orgId: uuid.required() });
export interface OrphanRefundsQuery extends PageQuery { status?: RefundStatusName }
export const orphanRefundsQuery = Joi.object<OrphanRefundsQuery>({ ...pageQuery, status: Joi.string().valid(...REFUND_STATUSES) });
export const orphanRefundParams = Joi.object<{ refundId: string }>({ refundId: uuid.required() });
export const refundParams = Joi.object<{ orgId: string; refundId: string }>({ orgId: uuid.required(), refundId: uuid.required() });
export const markDoneBody = Joi.object<{ note: string }>({ note: text({ multiline: true }).min(1).max(FIELD_LIMITS.reason).required() });

export const refundAdminResponse = Joi.object({
  id: uuidStrict, orderId: nullable(uuidStrict), eventId: nullable(uuidStrict), eventTitle: nullable(Joi.string()), buyerEmail: nullable(Joi.string()),
  amountCents: Joi.number().integer(),
  reason: Joi.string().valid('SELF_CANCELLATION', 'EVENT_CANCELLED', 'LATE_PAYMENT', 'DUPLICATE_PAYMENT', 'UNEXPECTED_PAYMENT'),
  method: Joi.string().valid('CARD', 'TRANSFER'), status: Joi.string().valid(...REFUND_STATUSES), note: nullable(Joi.string()),
  createdAt: isoDateOutput, updatedAt: isoDateOutput,
});
export const refundAdminPage = pageOf(refundAdminResponse);
