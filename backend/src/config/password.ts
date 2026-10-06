/** Longueurs du mot de passe (OWASP ASVS 2.1.1 / 2.1.2), en points de code. */
export const PASSWORD_MIN_CODE_POINTS = 12;
export const PASSWORD_MAX_CODE_POINTS = 128;
/** Longueur maximale en octets UTF-8 (borne le coût argon2 d'une entrée hostile). */
export const PASSWORD_MAX_BYTES = 256;

/** argon2id, recommandation OWASP Password Storage Cheat Sheet : 19 Mio, 2 itérations, parallélisme 1. */
export const ARGON2_MEMORY_KIB = 19_456;
export const ARGON2_TIME_COST = 2;
export const ARGON2_PARALLELISM = 1;

/** Calculs argon2 simultanés au plus (protège le CPU), et requêtes en file au-delà desquelles 429. */
export const ARGON2_MAX_CONCURRENT = 4;
export const ARGON2_MAX_QUEUE = 64;
