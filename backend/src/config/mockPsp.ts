import { minutes, seconds } from './units.js';

/** PSP simulé (dev / test uniquement) : délais de réessai d'une notification non acquittée (contrat 1.15 §9). */
export const MOCK_PSP_RETRY_DELAYS_MS: readonly number[] = [seconds(1), seconds(5), seconds(30), minutes(2), minutes(10)];
/** Notification « retardée » envoyée par défaut après ce délai (bouton de test de la page de paiement). */
export const MOCK_PSP_DELAYED_WEBHOOK_MS = seconds(30);
/** Octets aléatoires des identifiants (cs_…, pay_…, re_…, evt_…). */
export const MOCK_PSP_ID_BYTES = 12;
/** Montant maximal d'une session (centimes). */
export const MOCK_PSP_MAX_AMOUNT_CENTS = 100_000_000;
/** Longueur maximale des URL de retour et des clés d'idempotence. */
export const MOCK_PSP_URL_MAX_LENGTH = 500;
export const MOCK_PSP_KEY_MAX_LENGTH = 100;
/** Décimales affichées pour un montant en euros. */
export const EURO_DECIMALS = 2;
/** Corps acceptés par le PSP simulé : JSON de l'API, formulaire de la page de paiement. */
export const MOCK_PSP_JSON_LIMIT = '10kb';
export const MOCK_PSP_FORM_LIMIT = '1kb';
/** Délai de livraison d'un webhook par le serveur du PSP simulé. */
export const MOCK_PSP_DELIVERY_TIMEOUT_MS = seconds(10);
