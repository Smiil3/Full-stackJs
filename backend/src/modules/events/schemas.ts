import Joi from 'joi';
import { cents, isoDateInput, isoDateOutput, nullable, pageOf, pageQuery, text, timezone, uuid, uuidStrict, type PageQuery } from '../../lib/schemas.js';
import { settingsBounds } from '../orgs/schemas.js';
import type { EventOverrideFields } from '../settings/resolveEventSettings.js';
import { FIELD_LIMITS } from '../../config/fields.js';
import { TICKET_PRICE_MAX_CENTS } from '../../config/money.js';

export type OverridesInput = { [K in keyof EventOverrideFields]?: EventOverrideFields[K] };

const overrides = Joi.object<OverridesInput>(
  Object.fromEntries(Object.entries(settingsBounds).map(([k, schema]) => [k, nullable(schema)])),
);

export interface EventCreateBody {
  title: string; description?: string | null; venue?: string | null; address?: string | null; isOnline: boolean;
  startsAt: string; endsAt: string; timezone: string; salesStartAt: string; salesEndAt: string; overrides?: OverridesInput;
}
export type EventPatchBody = Partial<EventCreateBody> & { rescheduleReason?: string; offlineCheckinEnabled?: boolean };

const eventFields = {
  title: text().min(1).max(FIELD_LIMITS.eventTitle),
  description: nullable(text({ multiline: true }).max(FIELD_LIMITS.eventDescription)),
  venue: nullable(text().max(FIELD_LIMITS.venue)),
  address: nullable(text({ multiline: true }).max(FIELD_LIMITS.address)),
  isOnline: Joi.boolean(),
  startsAt: isoDateInput,
  endsAt: isoDateInput,
  timezone,
  salesStartAt: isoDateInput,
  salesEndAt: isoDateInput,
  overrides,
};

export const eventCreateBody = Joi.object<EventCreateBody>({
  ...eventFields,
  title: eventFields.title.required(),
  isOnline: eventFields.isOnline.required(),
  startsAt: eventFields.startsAt.required(),
  endsAt: eventFields.endsAt.required(),
  timezone: eventFields.timezone.required(),
  salesStartAt: eventFields.salesStartAt.required(),
  salesEndAt: eventFields.salesEndAt.required(),
});
export const eventPatchBody = Joi.object<EventPatchBody>({
  ...eventFields,
  // Surcharges : un objet vide n'a aucun effet ⇒ refusé (pas d'entrée d'audit vide).
  overrides: overrides.min(1),
  rescheduleReason: text({ multiline: true }).min(1).max(FIELD_LIMITS.reason),
  // Mode secours hors-ligne : OWNER uniquement (contrôlé dans le service).
  offlineCheckinEnabled: Joi.boolean(),
}).min(1);

export interface TicketTypeBody {
  name: string; description?: string | null; capacity: number; priceCents: number;
  earlyPriceCents?: number | null; earlyUntil?: string | null; sortOrder?: number;
}
export type TicketTypePatchBody = Partial<TicketTypeBody>;

const ttFields = {
  name: text().min(1).max(FIELD_LIMITS.name),
  description: nullable(text({ multiline: true }).max(FIELD_LIMITS.ticketTypeDescription)),
  capacity: Joi.number().integer().min(1).max(FIELD_LIMITS.capacityMax),
  priceCents: cents.max(TICKET_PRICE_MAX_CENTS),
  earlyPriceCents: nullable(cents.max(TICKET_PRICE_MAX_CENTS)),
  earlyUntil: nullable(isoDateInput),
  sortOrder: Joi.number().integer().min(0).max(FIELD_LIMITS.sortOrderMax),
};
export const ticketTypeCreateBody = Joi.object<TicketTypeBody>({
  ...ttFields,
  name: ttFields.name.required(),
  capacity: ttFields.capacity.required(),
  priceCents: ttFields.priceCents.required(),
});
export const ticketTypePatchBody = Joi.object<TicketTypePatchBody>(ttFields).min(1);

export const orgEventParams = Joi.object<{ orgId: string; eventId: string }>({ orgId: uuid.required(), eventId: uuid.required() });
export const ticketTypeParams = Joi.object<{ orgId: string; eventId: string; ticketTypeId: string }>({
  orgId: uuid.required(), eventId: uuid.required(), ticketTypeId: uuid.required(),
});
export const orgParams = Joi.object<{ orgId: string }>({ orgId: uuid.required() });
export interface EventListQuery extends PageQuery { status?: 'DRAFT' | 'PUBLISHED' | 'CANCELLED' }
export const eventListQuery = Joi.object<EventListQuery>({ ...pageQuery, status: Joi.string().valid('DRAFT', 'PUBLISHED', 'CANCELLED') });

// ---- Réponses ----
const int = Joi.number().integer();
export const publicRulesResponse = Joi.object({
  maxPerOrder: int, maxPerUser: int, transferEnabled: Joi.boolean(), cardHoldMinutes: int, transferHoldHours: int,
  selfCancellationEnabled: Joi.boolean(), cancellationDeadlineHours: int, refundPercent: int,
  serviceFeeFixedCents: int, serviceFeeBasisPoints: int, waitlistEnabled: Joi.boolean(),
});
export const overridesResponse = Joi.object(
  Object.fromEntries(Object.entries(settingsBounds).map(([k, schema]) => [k, nullable(schema)])),
);
export const ticketTypeAdminResponse = Joi.object({
  id: uuidStrict, name: Joi.string(), description: nullable(Joi.string()), capacity: int, sold: int, held: int, remaining: int,
  priceCents: int, earlyPriceCents: nullable(int), earlyUntil: nullable(isoDateOutput), sortOrder: int,
});
export const eventAdminResponse = Joi.object({
  id: uuidStrict, orgId: uuidStrict, title: Joi.string(), description: nullable(Joi.string()), venue: nullable(Joi.string()),
  address: nullable(Joi.string()), isOnline: Joi.boolean(), startsAt: isoDateOutput, endsAt: isoDateOutput, timezone: Joi.string(),
  status: Joi.string().valid('DRAFT', 'PUBLISHED', 'CANCELLED'), salesStartAt: isoDateOutput, salesEndAt: isoDateOutput,
  overrides: overridesResponse, offlineCheckinEnabled: Joi.boolean(), cancellationPendingOrders: int, effectiveRules: publicRulesResponse, ticketTypes: Joi.array().items(ticketTypeAdminResponse),
  createdAt: isoDateOutput, updatedAt: isoDateOutput,
});
export const eventAdminPage = pageOf(eventAdminResponse);
export const cancelEventBody = Joi.object<{ reason: string }>({ reason: text({ multiline: true }).min(1).max(FIELD_LIMITS.reason).required() });
