import { days } from './units.js';

/** Fiche publique d'un événement terminé : 404 au-delà de ce délai (contrat §7.2). */
export const PUBLIC_RETENTION_MS = days(30);
/** Disponibilité « LOW » : il reste au plus 1/10 de la capacité d'un type de place. */
export const LOW_STOCK_DIVISOR = 10;
/** Billets renvoyés au plus par GET /me/tickets. */
export const MY_TICKETS_MAX = 500;
