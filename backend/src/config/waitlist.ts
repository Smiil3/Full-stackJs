/** Accumulation de places pour la tête de file : durée maximale en minutes (anti-gel). */
export const MAX_ACCUMULATION_MINUTES = 30;
/** Offres non honorées par un compte sur un même événement avant sa sortie de la liste (contrat 1.18 §6). */
export const MAX_UNHONORED_OFFERS_PER_EVENT = 2;
/** Offre quittée dans ce délai après son émission : pas de pénalité (contrat 1.18 §6). */
export const WAITLIST_LEAVE_GRACE_MINUTES = 15;
/** Durée minimale d'une offre : en deçà (fin des ventes trop proche), aucune offre, les places vont au public. */
export const WAITLIST_MIN_OFFER_MINUTES = 15;
