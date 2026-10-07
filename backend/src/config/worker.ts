/** Commandes expirées au plus par passage du worker (une transaction chacune). */
export const EXPIRE_ORDERS_PER_TICK = 200;
/** Échecs d'expiration avant mise à l'écart d'une commande (alerte, intervention manuelle). */
export const MAX_EXPIRE_FAILURES = 5;
/** Commandes d'un événement annulé traitées au plus par passage. */
export const EVENT_CANCELLATIONS_PER_TICK = 500;
/** Offres de liste d'attente expirées au plus par passage. */
export const WAITLIST_OFFERS_PER_TICK = 200;
/** Export CSV : billets lus par page (streaming avec contre-pression). */
export const CSV_EXPORT_PAGE = 500;
/** Filet de la liste d'attente : types de places examinés au plus par passage. */
export const WAITLIST_SWEEP_TYPES_PER_TICK = 100;
/** Commandes d'un événement reporté traitées au plus par passage (droits du report + mail). */
export const RESCHEDULE_ORDERS_PER_TICK = 500;
