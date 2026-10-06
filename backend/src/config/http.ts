import { minutes, seconds } from './units.js';

/** Codes HTTP utilisés par l'API (RFC 9110) et le PSP simulé. */
export const HTTP_STATUS = {
  OK: 200,
  CREATED: 201,
  ACCEPTED: 202,
  NO_CONTENT: 204,
  SEE_OTHER: 303,
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  REQUEST_TIMEOUT: 408,
  CONFLICT: 409,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  UNPROCESSABLE_ENTITY: 422,
  TOO_EARLY: 425,
  TOO_MANY_REQUESTS: 429,
  INTERNAL_SERVER_ERROR: 500,
  BAD_GATEWAY: 502,
} as const;

/** Premier code d'erreur client (4xx) : journalisé en warn. */
export const HTTP_CLIENT_ERROR_MIN = 400;
/** Premier code d'erreur serveur (5xx) : journalisé en error. */
export const HTTP_SERVER_ERROR_MIN = 500;
/** Bornes de la classe 2xx (succès) : livraison de webhook acquittée. */
export const HTTP_SUCCESS_MIN = 200;
export const HTTP_SUCCESS_MAX_EXCLUSIVE = 300;

/** Tailles maximales des corps (contrat §1, D « corps limités ») : JSON courant. */
export const JSON_BODY_LIMIT = '10kb';
/** Corps brut du webhook PSP (signature HMAC sur les octets exacts). */
export const WEBHOOK_BODY_LIMIT = '64kb';
/** Synchronisation hors-ligne : 500 scans (contrat §7.4), lue seulement après authentification. */
export const SYNC_BODY_LIMIT = '160kb';
/** Même limite en octets, pour les invariants testés (1 ko = 1024 octets, notation body-parser). */
export const SYNC_BODY_LIMIT_BYTES = 160 * 1024;

/** Profondeur maximale d'un objet d'entrée parcouru (recherche de NUL / clés interdites). */
export const MAX_INPUT_DEPTH = 10;

/** Pagination (contrat §1) : page maximale, taille maximale et par défaut. */
export const PAGE_MAX = 1000;
export const PAGE_SIZE_MAX = 100;
export const PAGE_SIZE_DEFAULT = 20;

/** Arrêt du serveur : délai laissé aux requêtes en cours avant sortie forcée. */
export const SHUTDOWN_TIMEOUT_MS = seconds(10);

/** Retry-After annoncé quand le sémaphore argon2 est saturé. */
export const BUSY_RETRY_AFTER_SECONDS = 1;

/** Fenêtre par défaut d'un compteur de rate limiting (express-rate-limit l'impose avant init). */
export const DEFAULT_RATE_WINDOW_MS = minutes(1);

/** HSTS en production : un an (recommandation OWASP / hstspreload), sous-domaines inclus. */
export const HSTS_MAX_AGE_SECONDS = 31_536_000;
/** Durée de mise en cache d'une réponse CORS préliminaire (secondes). */
export const CORS_PREFLIGHT_MAX_AGE_SECONDS = 600;
