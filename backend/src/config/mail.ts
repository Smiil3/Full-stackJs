import { hours, minutes, seconds } from './units.js';

/** Outbox : essais avant abandon (FAILED, alerte). */
export const OUTBOX_MAX_ATTEMPTS = 8;
/** Mails envoyés par passage du worker. */
export const OUTBOX_BATCH = 20;
/** Bail posé avant l'envoi SMTP (envoi hors transaction). */
export const OUTBOX_LEASE_MS = minutes(5);
/** Backoff exponentiel : premier délai et plafond (aussi utilisé par les remboursements). */
export const BACKOFF_BASE_MS = seconds(30);
export const BACKOFF_MAX_MS = hours(1);
/** Facteur de croissance du backoff (30 s, 1 min, 2 min…). */
export const BACKOFF_FACTOR = 2;

/** Délais SMTP (nodemailer) : connexion, accueil du serveur, inactivité de la socket. */
export const SMTP_CONNECTION_TIMEOUT_MS = seconds(10);
export const SMTP_GREETING_TIMEOUT_MS = seconds(10);
export const SMTP_SOCKET_TIMEOUT_MS = seconds(20);

/** QR code joint aux mails de billets : marge (modules) et largeur de l'image PNG (pixels). */
export const QR_IMAGE_MARGIN = 2;
export const QR_IMAGE_WIDTH_PX = 512;
