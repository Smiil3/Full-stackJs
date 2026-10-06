import Joi from 'joi';
import { isoDateInput, isoDateOutput, nullable, pageOf, pageQuery, uuid, uuidStrict, type PageQuery } from '../../lib/schemas.js';
import { publicRulesResponse } from '../events/schemas.js';

export interface CatalogQuery extends PageQuery { orgSlug?: string; from?: string; to?: string }
export const catalogQuery = Joi.object<CatalogQuery>({
  ...pageQuery,
  orgSlug: Joi.string().pattern(/^[a-z0-9-]{2,40}$/),
  from: isoDateInput,
  to: isoDateInput,
});
export const eventIdParams = Joi.object<{ eventId: string }>({ eventId: uuid.required() });

const availability = Joi.string().valid('AVAILABLE', 'LOW', 'SOLD_OUT');
const int = Joi.number().integer();

const summaryFields = {
  id: uuidStrict, orgId: uuidStrict, orgName: Joi.string(), orgSlug: Joi.string(), title: Joi.string(), venue: nullable(Joi.string()),
  isOnline: Joi.boolean(), startsAt: isoDateOutput, endsAt: isoDateOutput, timezone: Joi.string(),
  coverAvailability: availability, fromPriceCents: int,
};
export const eventSummaryResponse = Joi.object(summaryFields);
export const eventSummaryPage = pageOf(eventSummaryResponse);

export const ticketTypePublicResponse = Joi.object({
  id: uuidStrict, name: Joi.string(), description: nullable(Joi.string()), currentPriceCents: int, regularPriceCents: int,
  isEarly: Joi.boolean(), earlyUntil: nullable(isoDateOutput), availability,
});

export const eventPublicResponse = Joi.object({
  ...summaryFields,
  description: nullable(Joi.string()), address: nullable(Joi.string()), salesStartAt: isoDateOutput, salesEndAt: isoDateOutput,
  salesOpen: Joi.boolean(), ticketTypes: Joi.array().items(ticketTypePublicResponse), rules: publicRulesResponse,
  contactEmail: nullable(Joi.string()),
});
