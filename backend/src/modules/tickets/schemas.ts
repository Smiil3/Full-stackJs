import Joi from 'joi';
import { isoDateOutput, nullable, uuidStrict } from '../../lib/schemas.js';
import { QR_PAYLOAD_MAX_LENGTH } from '../../config/checkin.js';

export const ticketResponse = Joi.object({
  id: uuidStrict,
  publicId: Joi.string().pattern(/^[A-Za-z0-9_-]{22}$/),
  status: Joi.string().valid('VALID', 'USED', 'CANCELLED'),
  usedAt: nullable(isoDateOutput),
  qrPayload: Joi.string().max(QR_PAYLOAD_MAX_LENGTH),
  ticketTypeName: Joi.string(),
  orderId: uuidStrict,
  event: Joi.object({
    id: uuidStrict, title: Joi.string(), venue: nullable(Joi.string()), isOnline: Joi.boolean(),
    startsAt: isoDateOutput, endsAt: isoDateOutput, timezone: Joi.string(),
  }),
});
export const myTicketsResponse = Joi.object({ items: Joi.array().items(ticketResponse) });
