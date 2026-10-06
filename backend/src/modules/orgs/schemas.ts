import Joi from 'joi';
import { BIC_PATTERN, isValidIban, normalizeIban } from '../../lib/iban.js';
import { email, isoDateOutput, nullable, pageOf, pageQuery, roleSchema, text, timezone, uuid, uuidStrict, type PageQuery } from '../../lib/schemas.js';
import { SETTINGS_BOUNDS } from '../../config/settingsBounds.js';
import { FIELD_LIMITS } from '../../config/fields.js';
import { PASSWORD_MAX_BYTES } from '../../config/password.js';

export type RoleName = 'OWNER' | 'MANAGER' | 'SCANNER';

const intIn = ({ min, max }: { readonly min: number; readonly max: number }) => Joi.number().integer().min(min).max(max);

/** Schémas des réglages configurables ; bornes dans config/settingsBounds.ts. */
export const settingsBounds = {
  cardHoldMinutes: intIn(SETTINGS_BOUNDS.cardHoldMinutes),
  transferHoldHours: intIn(SETTINGS_BOUNDS.transferHoldHours),
  transferEnabled: Joi.boolean(),
  cancellationDeadlineHours: intIn(SETTINGS_BOUNDS.cancellationDeadlineHours),
  selfCancellationEnabled: Joi.boolean(),
  refundPercent: intIn(SETTINGS_BOUNDS.refundPercent),
  maxPerOrder: intIn(SETTINGS_BOUNDS.maxPerOrder),
  maxPerUser: intIn(SETTINGS_BOUNDS.maxPerUser),
  waitlistOfferMinutes: intIn(SETTINGS_BOUNDS.waitlistOfferMinutes),
  waitlistEnabled: Joi.boolean(),
  serviceFeeFixedCents: intIn(SETTINGS_BOUNDS.serviceFeeFixedCents),
  serviceFeeBasisPoints: intIn(SETTINGS_BOUNDS.serviceFeeBasisPoints),
};

export const orgParams = Joi.object<{ orgId: string }>({ orgId: uuid.required() });
export const memberParams = Joi.object<{ orgId: string; userId: string }>({ orgId: uuid.required(), userId: uuid.required() });

export interface BankInput { beneficiary: string; iban: string; bic: string }
export interface SettingsPatch {
  cardHoldMinutes?: number; transferHoldHours?: number; transferEnabled?: boolean; cancellationDeadlineHours?: number;
  selfCancellationEnabled?: boolean; refundPercent?: number; serviceFeeRefundable?: boolean; maxPerOrder?: number; maxPerUser?: number;
  waitlistOfferMinutes?: number; waitlistEnabled?: boolean; serviceFeeFixedCents?: number; serviceFeeBasisPoints?: number;
  defaultTimezone?: string; contactEmail?: string | null; bank?: BankInput; currentPassword?: string;
}

const iban = text().max(FIELD_LIMITS.ibanInput)
  .custom((value: string, helpers) => (isValidIban(value) ? normalizeIban(value) : helpers.error('iban.invalid')))
  .messages({ 'iban.invalid': '{{#label}} n’est pas un IBAN SEPA valide' });

export const settingsPatchBody = Joi.object<SettingsPatch>({
  ...settingsBounds,
  serviceFeeRefundable: Joi.boolean(),
  defaultTimezone: timezone,
  contactEmail: nullable(email),
  bank: Joi.object<BankInput>({
    beneficiary: text().min(1).max(FIELD_LIMITS.beneficiary).required(),
    iban: iban.required(),
    bic: text().pattern(BIC_PATTERN, 'BIC').required().messages({ 'string.pattern.name': '{{#label}} n’est pas un BIC valide' }),
  }),
  // Ré-authentification obligatoire pour tout changement bancaire (et refusée sinon).
  currentPassword: text({ trim: false }).min(1).max(PASSWORD_MAX_BYTES)
    .when('bank', { is: Joi.exist(), then: Joi.required(), otherwise: Joi.forbidden() }),
}).min(1);

export interface AddMemberBody { email: string; role: RoleName }
export const addMemberBody = Joi.object<AddMemberBody>({ email: email.required(), role: roleSchema.required() });
export const updateMemberBody = Joi.object<{ role: RoleName }>({ role: roleSchema.required() });

export const auditQuery = Joi.object<PageQuery>(pageQuery);

// ---- Réponses ----
export const orgResponse = Joi.object({ id: uuidStrict, name: Joi.string(), slug: Joi.string(), createdAt: isoDateOutput });

export const orgSettingsResponse = Joi.object({
  cardHoldMinutes: Joi.number().integer(), transferHoldHours: Joi.number().integer(), transferEnabled: Joi.boolean(),
  cancellationDeadlineHours: Joi.number().integer(), selfCancellationEnabled: Joi.boolean(), refundPercent: Joi.number().integer(),
  serviceFeeRefundable: Joi.boolean(), maxPerOrder: Joi.number().integer(), maxPerUser: Joi.number().integer(),
  waitlistOfferMinutes: Joi.number().integer(), waitlistEnabled: Joi.boolean(), serviceFeeFixedCents: Joi.number().integer(),
  serviceFeeBasisPoints: Joi.number().integer(), defaultTimezone: Joi.string(), contactEmail: nullable(Joi.string()),
  bank: Joi.object({
    beneficiary: nullable(Joi.string()),
    // Jamais l'IBAN en clair : uniquement la forme masquée.
    ibanMasked: nullable(Joi.string().pattern(/^[A-Z]{2}\d{2} •••• •••• [A-Z0-9]{4}$/)),
    bic: nullable(Joi.string()),
  }),
});

export const memberResponse = Joi.object({
  userId: uuidStrict, email: Joi.string(), displayName: Joi.string(), role: roleSchema, createdAt: isoDateOutput,
});

export const auditEntryResponse = Joi.object({
  id: uuidStrict, actorEmail: nullable(Joi.string()), action: Joi.string(), target: Joi.string(),
  meta: Joi.object().unknown(true), createdAt: isoDateOutput,
});
export const auditPageResponse = pageOf(auditEntryResponse);
export const itemsMembers = Joi.object({ items: Joi.array().items(memberResponse) });
