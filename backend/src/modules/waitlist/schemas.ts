import Joi from 'joi';
import { isoDateOutput, nullable, uuid, uuidStrict } from '../../lib/schemas.js';
import { FIELD_LIMITS } from '../../config/fields.js';

export const joinParams = Joi.object<{ eventId: string; ticketTypeId: string }>({ eventId: uuid.required(), ticketTypeId: uuid.required() });
export const joinBody = Joi.object<{ quantity: number }>({ quantity: Joi.number().integer().min(1).max(FIELD_LIMITS.quantityPerLine).required() });
export const entryParams = Joi.object<{ entryId: string }>({ entryId: uuid.required() });

export const waitlistEntryResponse = Joi.object({
  id: uuidStrict, eventId: uuidStrict, eventTitle: Joi.string(), ticketTypeId: uuidStrict, ticketTypeName: Joi.string(),
  quantity: Joi.number().integer(), status: Joi.string().valid('WAITING', 'OFFERED', 'CONVERTED', 'EXPIRED', 'LEFT'),
  position: nullable(Joi.number().integer().min(1)), offerExpiresAt: nullable(isoDateOutput), createdAt: isoDateOutput,
});
export const myWaitlistResponse = Joi.object({ items: Joi.array().items(waitlistEntryResponse) });
