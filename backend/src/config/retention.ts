import { days, hours } from './units.js';

/**
 * Durées de conservation des données (audit B8, RGPD : minimisation). Purge quotidienne par le worker, par lots.
 * L'AuditLog est conservé (traçabilité des actions sensibles) ; commandes, paiements et billets restent
 * (obligations comptables).
 */
export const RETENTION = {
  /** Mails envoyés ou abandonnés (destinataire en clair) : 30 jours. */
  outboxMs: days(30),
  /** Jetons de lien mail consommés ou expirés : 7 jours. */
  emailTokensMs: days(7),
  /** Sessions expirées ou révoquées : 30 jours. */
  refreshTokensMs: days(30),
  /** Notifications du PSP (dédoublonnage) : 90 jours, bien au-delà de la fenêtre de réessai du PSP. */
  webhookEventsMs: days(90),
  /** Sessions de paiement terminées (commande hors attente de paiement) : 90 jours. */
  pspSessionsMs: days(90),
  /** Passages au contrôle : 1 an après la fin de l'événement. */
  checkInsAfterEventMs: days(365),
} as const;

/** Purge lancée au plus une fois par période (les durées se comptent en jours). */
export const RETENTION_PURGE_INTERVAL_MS = hours(1);
