import Joi from 'joi';
import { isoDateOutput, nullable, uuid, uuidStrict } from '../../lib/schemas.js';

export const orgParams = Joi.object<{ orgId: string }>({ orgId: uuid.required() });

export const checkinEventsResponse = Joi.object({
  items: Joi.array().items(Joi.object({
    id: uuidStrict, title: Joi.string(), venue: nullable(Joi.string()), isOnline: Joi.boolean(),
    startsAt: isoDateOutput, endsAt: isoDateOutput, timezone: Joi.string(), status: Joi.string().valid('PUBLISHED'),
  })),
});
