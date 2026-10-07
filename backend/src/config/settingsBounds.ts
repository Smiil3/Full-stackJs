/**
 * Bornes des réglages modifiables en back-office (OrganizationSettings et surcharges d'Event) —
 * plan, section « Paramètres configurables ». Les VALEURS restent en base ; seules les bornes sont ici.
 */
export const SETTINGS_BOUNDS = {
  /** Durée de réservation pour un paiement carte (minutes). */
  cardHoldMinutes: { min: 5, max: 60 },
  /** Durée de réservation pour un virement (heures, 10 jours max). */
  transferHoldHours: { min: 1, max: 240 },
  /** Délai d'annulation avant le début (heures, 30 jours max). */
  cancellationDeadlineHours: { min: 0, max: 720 },
  /** Part remboursée en cas d'annulation par l'acheteur (%). */
  refundPercent: { min: 0, max: 100 },
  /** Places par commande. */
  maxPerOrder: { min: 1, max: 20 },
  /** Places par personne et par événement. */
  maxPerUser: { min: 1, max: 50 },
  /** Délai de réponse à une offre de liste d'attente (minutes, 6 h max : anti-gel, contrat 1.17 §6). */
  waitlistOfferMinutes: { min: 15, max: 360 },
  /** Frais de service fixes (centimes, 10 € max). */
  serviceFeeFixedCents: { min: 0, max: 1000 },
  /** Frais de service proportionnels (points de base, 15 % max). */
  serviceFeeBasisPoints: { min: 0, max: 1500 },
} as const;

/**
 * Surcharges d'événement à portée FINANCIÈRE (contrat 1.17 §7.2) : réservées à l'OWNER, auditées champ par champ,
 * notifiées à tous les OWNER. Les autres surcharges (durées de réservation, plafonds, liste d'attente) restent MANAGER+.
 */
export const FINANCIAL_OVERRIDE_KEYS = [
  'refundPercent', 'serviceFeeFixedCents', 'serviceFeeBasisPoints', 'transferEnabled', 'selfCancellationEnabled', 'cancellationDeadlineHours',
] as const;
