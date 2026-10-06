import { hours, minutes } from './units.js';

/** Fenêtre de contrôle (contrat §7.4) : ouverture avant le début… */
export const CHECKIN_OPENS_BEFORE_MS = hours(12);
/** … et fermeture après la fin (aussi : événements listés au contrôle). */
export const CHECKIN_CLOSES_AFTER_MS = hours(24);
/** Horodatage d'un scan hors-ligne : avance tolérée sur l'horloge serveur (au-delà, borné et journalisé). */
export const SCAN_FUTURE_TOLERANCE_MS = minutes(5);
/** Scans par lot de synchronisation (contrat §7.4 : 1–500). */
export const SYNC_MAX_SCANS = 500;
/** Quota de scans synchronisés par contrôleur et par minute (un lot de 500 compte pour 500). */
export const SYNC_SCANS_PER_MINUTE = 2000;
/** Longueur maximale d'un QR présenté (contrat §7.4). */
export const QR_PAYLOAD_MAX_LENGTH = 256;
/** Parties d'un QR `NG1.<eventId>.<publicId>.<signature>` (contrat §5). */
export const QR_PARTS = 4;
/** QR mal formés : une alerte journalisée toutes les N occurrences (pas de ligne en base). */
export const INVALID_QR_LOG_EVERY = 100;
/** Initiales du porteur : au plus N lettres (minimisation des données hors-ligne). */
export const HOLDER_INITIALS_MAX = 3;
/** Identifiant public d'un billet : 128 bits aléatoires (contrat §5). */
export const TICKET_PUBLIC_ID_BYTES = 16;
/** Événements listés au plus pour le contrôle (GET …/checkin/events). */
export const CHECKIN_EVENTS_LIST_MAX = 100;
