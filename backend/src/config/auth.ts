import { days, hours, minutes, seconds } from './units.js';

/** Durée de vie du jeton d'accès JWT, en secondes (contrat §2 : expiresIn = 600). */
export const ACCESS_TOKEN_TTL_SECONDS = 600;
/** Durée de vie d'un refresh token (renouvelé à chaque rotation). */
export const REFRESH_TTL_MS = days(30);
/** Durée de vie absolue d'une famille de refresh : reconnexion obligatoire au-delà (SECURITY.md). */
export const REFRESH_FAMILY_MAX_MS = days(90);
/** Délai de grâce de rotation : réponse de refresh perdue sur réseau mobile (D B2.1). */
export const REFRESH_GRACE_MS = seconds(10);

/** Validité d'un lien mail (vérification, reset) — SECURITY.md « Liens mail ». */
export const EMAIL_TOKEN_TTL_MINUTES = 30;
/** Intervalle minimal entre deux mails d'authentification pour un même compte. */
export const MAIL_MIN_INTERVAL_MINUTES = 2;
/** Fenêtre du plafond quotidien de mails d'authentification. */
export const MAIL_DAILY_WINDOW_MS = hours(24);
/** Plafond de mails d'authentification par compte et par 24 h. */
export const MAIL_MAX_PER_DAY = 10;

/** Verrouillage progressif (OWASP ASVS 2.2.1) : échecs avant verrou. */
export const LOCK_THRESHOLD = 5;
/** Durée maximale du verrou (1, 2, 4… plafonné), en minutes — SECURITY.md « Verrouillage de compte ». */
export const MAX_LOCK_MINUTES = 15;
/** Fenêtre glissante de comptage des échecs, en minutes. */
export const FAILURE_WINDOW_MINUTES = 15;
/** Base de la progression géométrique du verrou (1, 2, 4, 8… minutes). */
export const LOCK_GROWTH_FACTOR = 2;

/** Gigue cryptographique ajoutée au plancher de réponse (anti-oracle de timing), borne incluse. */
export const RESPONSE_FLOOR_JITTER_MAX_MS = 100;

/** Quotas par adresse email (en plus des limites par IP), appliqués que le compte existe ou non. */
export const AUTH_EMAIL_QUOTAS = {
  login: { windowMs: minutes(15), max: 30 },
  mail: { windowMs: hours(1), max: 5 },
} as const;

/**
 * Plafond GLOBAL d'un compte, toutes adresses IP confondues (audit M7) : bien plus haut que le verrou par couple
 * (compte, IP), il ne se déclenche que sur une attaque distribuée. Fenêtre en minutes, verrou fixe en minutes.
 */
export const ACCOUNT_LOCK_THRESHOLD = 50;
export const ACCOUNT_FAILURE_WINDOW_MINUTES = 60;
export const ACCOUNT_LOCK_MINUTES = 15;
