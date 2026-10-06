/** Transaction en conflit (interblocage, sérialisation) : essais au plus, puis 409 CONFLICT. */
export const TX_RETRY_ATTEMPTS = 3;
/** Pause aléatoire avant nouvel essai (ms, multipliée par le rang de l'essai). */
export const TX_RETRY_JITTER_MIN_MS = 10;
export const TX_RETRY_JITTER_MAX_MS = 60;
/** Profondeur maximale de la chaîne `cause` explorée pour reconnaître une erreur transitoire. */
export const ERROR_CAUSE_MAX_DEPTH = 3;
/** Connexions au plus dans le pool PostgreSQL d'un processus (API ou worker). */
export const DB_POOL_MAX = 20;
/** Transaction interactive : attente maximale d'une connexion, puis durée maximale d'exécution. */
export const TX_MAX_WAIT_MS = 10_000;
export const TX_TIMEOUT_MS = 20_000;
