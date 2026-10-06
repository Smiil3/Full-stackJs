import Joi from 'joi';
import { cents, pageOf, pageQuery, text, uuid, uuidStrict, type PageQuery } from '../../lib/schemas.js';
import { orderFields } from '../orders/schemas.js';
import { FIELD_LIMITS } from '../../config/fields.js';

export const orderAdminResponse = Joi.object({
  ...orderFields,
  buyer: Joi.object({ id: uuidStrict, email: Joi.string(), displayName: Joi.string() }),
});
export const orderAdminPage = pageOf(orderAdminResponse);

export interface EventOrdersQuery extends PageQuery {
  status?: 'PENDING_PAYMENT' | 'AWAITING_TRANSFER' | 'PAID' | 'EXPIRED' | 'CANCELLED' | 'REFUNDED';
  q?: string;
}
export const eventOrdersQuery = Joi.object<EventOrdersQuery>({
  ...pageQuery,
  status: Joi.string().valid('PENDING_PAYMENT', 'AWAITING_TRANSFER', 'PAID', 'EXPIRED', 'CANCELLED', 'REFUNDED'),
  q: text().max(FIELD_LIMITS.searchQuery),
});
export const eventParams = Joi.object<{ orgId: string; eventId: string }>({ orgId: uuid.required(), eventId: uuid.required() });
export const orderParams = Joi.object<{ orgId: string; orderId: string }>({ orgId: uuid.required(), orderId: uuid.required() });
export const confirmTransferBody = Joi.object<{ receivedAmountCents: number }>({ receivedAmountCents: cents.required() });
