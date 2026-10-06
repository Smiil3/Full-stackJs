import { minutes, seconds } from './units.js';

/** Délai maximal d'un appel au PSP (création de session, consultation, remboursement). */
export const PSP_TIMEOUT_MS = seconds(8);
/** Longueur maximale d'un identifiant renvoyé par le PSP (session, paiement, remboursement). */
export const PSP_ID_MAX_LENGTH = 100;
/** Tolérance d'horodatage d'un webhook signé (contrat §9 : ±5 min). */
export const WEBHOOK_TOLERANCE_SECONDS = 300;
/** Signatures de webhook invalides tolérées par IP et par minute (contrat 1.15 §9). */
export const INVALID_WEBHOOKS_PER_MINUTE = 60;
/** Montant maximal accepté dans un webhook (centimes) : borne de validation, jamais un plafond métier. */
export const WEBHOOK_MAX_AMOUNT_CENTS = 100_000_000;
/** Longueurs maximales des champs de webhook : type d'événement (entrée / stocké) et identifiants. */
export const WEBHOOK_TYPE_MAX_LENGTH = 64;
export const WEBHOOK_TYPE_STORED_LENGTH = 50;

/** Rapprochement (contrat 1.15 §9) : sessions consultées par passage du worker. */
export const RECONCILE_BATCH = 20;
/** Âge minimal d'une session et délai entre deux consultations d'une même session. */
export const RECONCILE_RECHECK_MS = minutes(1);
/** PSP injoignable : expiration d'une commande carte différée au plus de ce délai (D B9). */
export const RECONCILE_GRACE_MS = minutes(15);
