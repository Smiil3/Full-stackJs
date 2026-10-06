import { lookup } from '../lib/lookup';
import { ERROR_CODES, type ErrorCode, type ErrorDetails } from './types';

/** Codes propres au client (jamais renvoyés par l'API). */
export type ClientErrorCode = 'NETWORK_ERROR' | 'TIMEOUT' | 'UNEXPECTED_RESPONSE' | 'SESSION_CHANGED';
export type AnyErrorCode = ErrorCode | ClientErrorCode;

export class ApiError extends Error {
  readonly status: number;
  readonly code: AnyErrorCode;
  readonly details: ErrorDetails | undefined;
  /** Secondes à attendre, lues dans `Retry-After` (429). */
  readonly retryAfter: number | undefined;

  constructor(opts: {
    status: number;
    code: AnyErrorCode;
    message: string;
    details?: ErrorDetails | undefined;
    retryAfter?: number | undefined;
  }) {
    super(opts.message);
    this.name = 'ApiError';
    this.status = opts.status;
    this.code = opts.code;
    this.details = opts.details;
    this.retryAfter = opts.retryAfter;
  }
}

export function isApiError(e: unknown): e is ApiError {
  return e instanceof ApiError;
}

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && (ERROR_CODES as readonly string[]).includes(value);
}

/**
 * Messages destinés à des non-techniciens. On n'affiche jamais le `message` brut du serveur
 * (il peut changer, être technique ou en anglais) : on part du code, stable et contractuel.
 */
const MESSAGES: Record<AnyErrorCode, string> = {
  VALIDATION_ERROR: 'Certaines informations saisies ne sont pas valides. Vérifiez le formulaire.',
  UNAUTHENTICATED: 'Votre session a expiré. Merci de vous reconnecter.',
  INVALID_CREDENTIALS: 'Adresse email ou mot de passe incorrect.',
  INVALID_REFRESH_TOKEN: 'Votre session a expiré. Merci de vous reconnecter.',
  FORBIDDEN: 'Vous n’avez pas les droits nécessaires pour cette action.',
  EMAIL_NOT_VERIFIED: 'Confirmez d’abord votre adresse email (lien reçu par mail) pour continuer.',
  CSRF_CHECK_FAILED: 'La requête a été bloquée par sécurité. Rechargez la page puis réessayez.',
  NOT_FOUND: 'Cet élément est introuvable ou n’est plus disponible.',
  SOLD_OUT: 'Il n’y a plus assez de places disponibles pour ce choix.',
  SALES_CLOSED: 'La billetterie de cet événement est fermée.',
  ORDER_EXPIRED: 'Le délai de réservation est dépassé : les places ont été libérées.',
  INVALID_STATE: 'Cette action n’est plus possible pour cette commande.',
  IDEMPOTENCY_CONFLICT: 'Votre commande a changé pendant l’envoi. Rechargez la page puis recommencez.',
  ALREADY_IN_WAITLIST: 'Vous êtes déjà inscrit·e sur la liste d’attente pour ces places.',
  NOT_SOLD_OUT: 'Des places sont de nouveau disponibles : vous pouvez réserver directement.',
  OFFER_EXPIRED: 'Cette offre de la liste d’attente a expiré.',
  OFFLINE_CHECKIN_DISABLED: 'Le mode secours hors-ligne n’est pas activé pour cet événement.',
  WAITLIST_DISABLED: 'La liste d’attente n’est pas proposée pour cet événement.',
  CANCELLATION_CLOSED: 'L’annulation n’est plus possible pour cette commande.',
  CONFLICT: 'Cette action entre en conflit avec l’état actuel. Rechargez la page.',
  LIMIT_EXCEEDED: 'Vous dépassez le nombre maximum de places autorisé.',
  PAYMENT_METHOD_UNAVAILABLE: 'Ce mode de paiement n’est pas disponible pour cet événement.',
  AMOUNT_MISMATCH: 'Le montant reçu ne correspond pas au montant dû.',
  PAYLOAD_TOO_LARGE: 'Les informations envoyées sont trop volumineuses. Raccourcissez votre saisie.',
  UNSUPPORTED_MEDIA_TYPE: 'Format d’envoi non pris en charge. Rechargez la page puis réessayez.',
  RATE_LIMITED: 'Trop de tentatives. Patientez un instant avant de réessayer.',
  INTERNAL_ERROR: 'Un problème technique est survenu. Réessayez dans quelques instants.',
  NETWORK_ERROR: 'Connexion impossible. Vérifiez votre réseau puis réessayez.',
  TIMEOUT: 'Le serveur met trop de temps à répondre. Réessayez.',
  UNEXPECTED_RESPONSE: 'Réponse inattendue du serveur. Réessayez dans quelques instants.',
  SESSION_CHANGED: 'Votre session a changé entre-temps. Réessayez.',
};

/** Message français lisible, enrichi des `details` contractuels quand ils sont utiles. */
export function errorMessage(error: unknown): string {
  if (!isApiError(error)) return MESSAGES.INTERNAL_ERROR;
  const base = lookup(MESSAGES, error.code) ?? MESSAGES.INTERNAL_ERROR;
  const d = error.details;
  if (error.code === 'LIMIT_EXCEEDED' && d && typeof d.max === 'number') {
    const owned = typeof d.alreadyOwned === 'number' && d.alreadyOwned > 0 ? ` Vous en avez déjà ${d.alreadyOwned}.` : '';
    return `Vous ne pouvez pas dépasser ${d.max} place${d.max > 1 ? 's' : ''}.${owned}`;
  }
  if (error.code === 'RATE_LIMITED' && error.retryAfter !== undefined) {
    return `Trop de tentatives. Réessayez dans ${error.retryAfter} seconde${error.retryAfter > 1 ? 's' : ''}.`;
  }
  return base;
}

const INVALID_DATE = 'Date invalide ou incohérente avec les autres dates de l’événement.';
const INVALID_EMAIL = 'Adresse email invalide.';
const INVALID_PRICE = 'Prix invalide (montant positif, en euros).';
/**
 * Libellés français des erreurs de champ, par chemin complet puis par dernier segment
 * (`items.0.quantity` ⇒ `quantity`). Le message brut du serveur n'est jamais affiché.
 */
const FIELD_MESSAGES: Partial<Record<string, string>> = {
  email: INVALID_EMAIL,
  contactEmail: INVALID_EMAIL,
  ownerEmail: INVALID_EMAIL,
  password: 'Mot de passe refusé : 12 à 128 caractères, et pas un mot de passe courant.',
  newPassword: 'Nouveau mot de passe refusé : 12 à 128 caractères, pas un mot de passe courant, différent de l’actuel.',
  currentPassword: 'Mot de passe actuel requis.',
  displayName: 'Nom requis (texte court).',
  token: 'Lien invalide ou expiré.',
  title: 'Titre requis (texte court).',
  description: 'Description trop longue ou invalide.',
  venue: 'Lieu invalide.',
  address: 'Adresse invalide.',
  startsAt: INVALID_DATE,
  endsAt: 'Fin invalide : elle doit suivre le début et être dans le futur.',
  salesStartAt: INVALID_DATE,
  salesEndAt: INVALID_DATE,
  earlyUntil: INVALID_DATE,
  timezone: 'Fuseau horaire inconnu.',
  capacity: 'Capacité invalide (nombre entier positif).',
  priceCents: INVALID_PRICE,
  earlyPriceCents: INVALID_PRICE,
  quantity: 'Quantité invalide.',
  name: 'Nom requis (texte court).',
  slug: 'Identifiant d’adresse invalide : lettres minuscules, chiffres et tirets.',
  iban: 'IBAN invalide.',
  bic: 'BIC invalide.',
  beneficiary: 'Nom du bénéficiaire requis.',
  rescheduleReason: 'Le motif du report est obligatoire.',
  maxPerUser: 'Valeur invalide : au moins égale au maximum de places par commande.',
};
const GENERIC_FIELD_MESSAGE = 'Valeur invalide : vérifiez ce champ.';

/** Libellé français d'une erreur de champ (jamais le texte brut renvoyé par le serveur). */
export function fieldMessage(path: string): string {
  const last = path.split('.').pop() ?? path;
  return lookup(FIELD_MESSAGES, path) ?? lookup(FIELD_MESSAGES, last) ?? GENERIC_FIELD_MESSAGE;
}

/** Erreurs de champ (VALIDATION_ERROR), indexées par chemin, avec des libellés français connus. */
export function fieldErrors(error: unknown): Record<string, string> {
  if (!isApiError(error) || error.code !== 'VALIDATION_ERROR') return {};
  const out: Record<string, string> = {};
  for (const f of error.details?.fields ?? []) {
    if (typeof f.path === 'string' && !(f.path in out)) out[f.path] = fieldMessage(f.path);
  }
  return out;
}
