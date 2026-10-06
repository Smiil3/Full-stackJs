/**
 * Unités de temps et conversions. Plus aucun `60_000`, `3600_000` ou `/ 1000` ailleurs dans le code :
 * une durée s'écrit `minutes(15)`, `hours(12)`, `days(30)`.
 */

/** Millisecondes dans une seconde (conversions horodatages Unix ↔ Date). */
export const SECOND_MS = 1000;
/** Secondes dans une minute. */
export const SECONDS_PER_MINUTE = 60;
/** Minutes dans une heure. */
export const MINUTES_PER_HOUR = 60;
/** Heures dans un jour. */
export const HOURS_PER_DAY = 24;

/** Une minute en millisecondes. */
export const MINUTE_MS = SECONDS_PER_MINUTE * SECOND_MS;
/** Une heure en millisecondes. */
export const HOUR_MS = MINUTES_PER_HOUR * MINUTE_MS;
/** Un jour en millisecondes. */
export const DAY_MS = HOURS_PER_DAY * HOUR_MS;

export const seconds = (n: number): number => n * SECOND_MS;
export const minutes = (n: number): number => n * MINUTE_MS;
export const hours = (n: number): number => n * HOUR_MS;
export const days = (n: number): number => n * DAY_MS;

/** Horodatage Unix (secondes entières) d'une date en millisecondes. */
export const toUnixSeconds = (ms: number): number => Math.floor(ms / SECOND_MS);
/** Millisecondes d'un horodatage Unix en secondes. */
export const fromUnixSeconds = (s: number): number => s * SECOND_MS;
/** Durée en secondes arrondie au supérieur (en-tête Retry-After). */
export const ceilSeconds = (ms: number): number => Math.ceil(ms / SECOND_MS);
