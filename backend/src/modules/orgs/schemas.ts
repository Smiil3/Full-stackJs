import Joi from 'joi';
import { BIC_PATTERN, isValidIban, normalizeIban } from '../../lib/iban.js';
import { email, isoDateOutput, nullable, pageOf, pageQuery, roleSchema, text, timezone, uuid, uuidStrict, type PageQuery } from '../../lib/schemas.js';

export type RoleName = 'OWNER' | 'MANAGER' | 'SCANNER';

/** Bornes des réglages configurables (plan, section « Paramètres configurables »). */
export const settingsBounds = {
  cardHoldMinutes: Joi.number().integer().min(5).max(60),
  transferHoldHours: Joi.number().integer().min(1).max(240),
  transferEnabled: Joi.boolean(),
  cancellationDeadlineHours: Joi.number().integer().min(0).max(720),
  selfCancellationEnabled: Joi.boolean(),
  refundPercent: Joi.number().integer().min(0).max(100),
  maxPerOrder: Joi.number().integer().min(1).max(20),
  maxPerUser: Joi.number().integer().min(1).max(50),
  waitlistOfferMinutes: Joi.number().integer().min(15).max(2880),
  waitlistEnabled: Joi.boolean(),
  serviceFeeFixedCents: Joi.number().integer().min(0).max(1000),
  serviceFeeBasisPoints: Joi.number().integer().min(0).max(1500),
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

const iban = text().max(42)
  .custom((value: string, helpers) => (isValidIban(value) ? normalizeIban(value) : helpers.error('iban.invalid')))
  .messages({ 'iban.invalid': '{{#label}} n’est pas un IBAN SEPA valide' });

export const settingsPatchBody = Joi.object<SettingsPatch>({
  ...settingsBounds,
  serviceFeeRefundable: Joi.boolean(),
  defaultTimezone: timezone,
  contactEmail: nullable(email),
  bank: Joi.object<BankInput>({
    beneficiary: text().min(1).max(70).required(),
    iban: iban.required(),
    bic: text().pattern(BIC_PATTERN, 'BIC').required().messages({ 'string.pattern.name': '{{#label}} n’est pas un BIC valide' }),
  }),
  // Ré-authentification obligatoire pour tout changement bancaire (et refusée sinon).
  currentPassword: text({ trim: false }).min(1).max(256)
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
