import { hours, minutes } from './units.js';
import { AUTH_EMAIL_QUOTAS } from './auth.js';
import { INVALID_WEBHOOKS_PER_MINUTE } from './payments.js';
import { SYNC_SCANS_PER_MINUTE } from './checkin.js';

/**
 * TOUS les plafonds de requêtes au même endroit (SECURITY.md « Rate limiting »).
 * Compteurs partagés dans PostgreSQL ; `max` est multiplié par RATE_LIMIT_MULTIPLIER (1 en production).
 *
 * | Limiteur      | Clé            | Fenêtre | Plafond |
 * |---------------|----------------|---------|---------|
 * | globalIp      | IP             | 1 min   | 3000    |
 * | global        | compte, sinon IP | 1 min | 300     |
 * | orderPoll     | compte, sinon IP | 1 min | 120     |
 * | login         | IP             | 15 min  | 20      |
 * | register      | IP             | 1 h     | 10      |
 * | emailActions  | IP             | 1 h     | 10      |
 * | refresh       | IP             | 1 min   | 30      |
 * | orders        | IP             | 1 min   | 60      |
 * | ordersPerUser | compte         | 1 min   | 10      |
 * | scan          | IP             | 1 min   | 2400    |
 * | scanPerUser   | contrôleur     | 1 min   | 240     |
 */
export const RATE_LIMITS = {
  /** Filet anti-inondation par IP, large (NAT de salle, CGNAT mobile). */
  globalIp: { windowMs: minutes(1), max: 3000 },
  /** Plafond général par compte (sinon par IP), hors routes à plafond propre. */
  global: { windowMs: minutes(1), max: 300 },
  /** Suivi d'une commande (le front interroge toutes les 2 s, 60 s max, contrat §4). */
  orderPoll: { windowMs: minutes(1), max: 120 },
  login: { windowMs: minutes(15), max: 20 },
  register: { windowMs: hours(1), max: 10 },
  emailActions: { windowMs: hours(1), max: 10 },
  refresh: { windowMs: minutes(1), max: 30 },
  /** Réservation par IP (opérateurs mobiles en CGNAT : beaucoup d'acheteurs derrière une IP). */
  orders: { windowMs: minutes(1), max: 60 },
  /** Réservation par compte (après authentification). */
  ordersPerUser: { windowMs: minutes(1), max: 10 },
  /** Contrôle : wifi de salle partagé ⇒ plafond IP large ; le vrai plafond est par contrôleur. */
  scan: { windowMs: minutes(1), max: 2400 },
  scanPerUser: { windowMs: minutes(1), max: 240 },
} as const;

/** Quotas applicatifs (consumeQuota), même store. */
export const QUOTAS = {
  /** Par adresse email : connexion et mails d'authentification. */
  authLogin: AUTH_EMAIL_QUOTAS.login,
  authMail: AUTH_EMAIL_QUOTAS.mail,
  /** Signatures de webhook invalides par IP (contrat 1.15 §9). */
  webhookInvalid: { windowMs: minutes(1), max: INVALID_WEBHOOKS_PER_MINUTE },
  /** Scans synchronisés par contrôleur (comptés à l'unité). */
  scanSync: { windowMs: minutes(1), max: SYNC_SCANS_PER_MINUTE },
} as const;

/** Compteurs expirés conservés ce délai avant purge (diagnostic). */
export const RATE_BUCKET_RETENTION_MS = hours(1);
/** Longueur maximale d'une clé de compteur (préfixe + empreinte SHA-256). */
export const RATE_BUCKET_KEY_MAX_LENGTH = 100;
/** Retry-After minimal annoncé (secondes). */
export const MIN_RETRY_AFTER_SECONDS = 1;
