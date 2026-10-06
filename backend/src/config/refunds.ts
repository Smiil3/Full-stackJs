import { HTTP_STATUS } from './http.js';
import { minutes } from './units.js';

/** Remboursements traités par passage du worker. */
export const REFUND_BATCH = 20;
/** Bail posé avant l'appel PSP : un crash pendant l'appel ne provoque pas de double appel immédiat. */
export const REFUND_LEASE_MS = minutes(5);
/** Essais avant traitement manuel (MANUAL_REQUIRED, jamais un échec silencieux). */
export const MAX_REFUND_ATTEMPTS = 10;
/** Remboursement accepté mais pas exécuté (« pending ») : reconsulté après ce délai. */
export const REFUND_PENDING_RECHECK_MS = minutes(10);
/** Erreurs PSP 4xx néanmoins transitoires (réessayées). */
export const TRANSIENT_PSP_STATUSES: readonly number[] = [
  HTTP_STATUS.REQUEST_TIMEOUT, HTTP_STATUS.CONFLICT, HTTP_STATUS.TOO_EARLY, HTTP_STATUS.TOO_MANY_REQUESTS,
];
/** Longueur maximale du dernier message d'erreur conservé. */
export const REFUND_LAST_ERROR_MAX_LENGTH = 200;
