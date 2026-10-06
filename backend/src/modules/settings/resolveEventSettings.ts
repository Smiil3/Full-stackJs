import type { Event, OrganizationSettings } from '../../generated/prisma/client.js';

/** Règles effectives d'un événement : surcharge événement si non nulle, sinon réglage du collectif. */
export interface EffectiveRules {
  cardHoldMinutes: number;
  transferHoldHours: number;
  transferEnabled: boolean;
  cancellationDeadlineHours: number;
  selfCancellationEnabled: boolean;
  refundPercent: number;
  serviceFeeRefundable: boolean;
  maxPerOrder: number;
  maxPerUser: number;
  waitlistOfferMinutes: number;
  waitlistEnabled: boolean;
  serviceFeeFixedCents: number;
  serviceFeeBasisPoints: number;
  /** Virement réellement possible : activé ET coordonnées bancaires complètes. */
  bankConfigured: boolean;
}

/** Règles exposées au public (contrat : EventRulesPublic). */
export type PublicRules = Omit<EffectiveRules, 'serviceFeeRefundable' | 'waitlistOfferMinutes' | 'bankConfigured'>;

/** Réglages du collectif utiles à la résolution (jamais besoin de l'IBAN, même chiffré). */
export type SettingsForRules = Pick<
  OrganizationSettings,
  | 'cardHoldMinutes' | 'transferHoldHours' | 'transferEnabled' | 'cancellationDeadlineHours' | 'selfCancellationEnabled'
  | 'refundPercent' | 'serviceFeeRefundable' | 'maxPerOrder' | 'maxPerUser' | 'waitlistOfferMinutes' | 'waitlistEnabled'
  | 'serviceFeeFixedCents' | 'serviceFeeBasisPoints' | 'bankBeneficiary' | 'bankIbanMasked' | 'bankBic'
>;

export type EventOverrideFields = Pick<
  Event,
  | 'cardHoldMinutes' | 'transferHoldHours' | 'transferEnabled' | 'cancellationDeadlineHours' | 'selfCancellationEnabled'
  | 'refundPercent' | 'maxPerOrder' | 'maxPerUser' | 'waitlistOfferMinutes' | 'waitlistEnabled'
  | 'serviceFeeFixedCents' | 'serviceFeeBasisPoints'
>;

export const OVERRIDE_KEYS = [
  'cardHoldMinutes', 'transferHoldHours', 'transferEnabled', 'cancellationDeadlineHours', 'selfCancellationEnabled',
  'refundPercent', 'maxPerOrder', 'maxPerUser', 'waitlistOfferMinutes', 'waitlistEnabled',
  'serviceFeeFixedCents', 'serviceFeeBasisPoints',
] as const satisfies readonly (keyof EventOverrideFields)[];

/**
 * Point de résolution UNIQUE des réglages, utilisé par tous les services (réservation, annulation,
 * liste d'attente, virement, calcul du total). Les valeurs sont ensuite figées sur la commande.
 */
export function resolveEventSettings(org: SettingsForRules, event: EventOverrideFields): EffectiveRules {
  const maxPerUser = event.maxPerUser ?? org.maxPerUser;
  return {
    cardHoldMinutes: event.cardHoldMinutes ?? org.cardHoldMinutes,
    transferHoldHours: event.transferHoldHours ?? org.transferHoldHours,
    transferEnabled: event.transferEnabled ?? org.transferEnabled,
    cancellationDeadlineHours: event.cancellationDeadlineHours ?? org.cancellationDeadlineHours,
    selfCancellationEnabled: event.selfCancellationEnabled ?? org.selfCancellationEnabled,
    refundPercent: event.refundPercent ?? org.refundPercent,
    serviceFeeRefundable: org.serviceFeeRefundable,
    // Invariant : un plafond par commande ne dépasse jamais le plafond par personne (mélange d'héritages).
    maxPerOrder: Math.min(event.maxPerOrder ?? org.maxPerOrder, maxPerUser),
    maxPerUser,
    waitlistOfferMinutes: event.waitlistOfferMinutes ?? org.waitlistOfferMinutes,
    waitlistEnabled: event.waitlistEnabled ?? org.waitlistEnabled,
    serviceFeeFixedCents: event.serviceFeeFixedCents ?? org.serviceFeeFixedCents,
    serviceFeeBasisPoints: event.serviceFeeBasisPoints ?? org.serviceFeeBasisPoints,
    // La forme masquée n'existe que si un IBAN chiffré a été enregistré.
    bankConfigured: org.bankBeneficiary !== null && org.bankIbanMasked !== null && org.bankBic !== null,
  };
}

export function toPublicRules(rules: EffectiveRules): PublicRules {
  return {
    maxPerOrder: rules.maxPerOrder,
    maxPerUser: rules.maxPerUser,
    // Le public ne voit le virement que s'il est réellement utilisable.
    transferEnabled: rules.transferEnabled && rules.bankConfigured,
    cardHoldMinutes: rules.cardHoldMinutes,
    transferHoldHours: rules.transferHoldHours,
    selfCancellationEnabled: rules.selfCancellationEnabled,
    cancellationDeadlineHours: rules.cancellationDeadlineHours,
    refundPercent: rules.refundPercent,
    serviceFeeFixedCents: rules.serviceFeeFixedCents,
    serviceFeeBasisPoints: rules.serviceFeeBasisPoints,
    waitlistEnabled: rules.waitlistEnabled,
  };
}

export function overridesOf(event: EventOverrideFields): EventOverrideFields {
  const out = {} as Record<string, unknown>;
  for (const key of OVERRIDE_KEYS) out[key] = event[key];
  return out as EventOverrideFields;
}
