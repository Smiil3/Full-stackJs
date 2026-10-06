/** Codes d'erreur du contrat d'API (§1). */
export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNAUTHENTICATED'
  | 'INVALID_CREDENTIALS'
  | 'INVALID_REFRESH_TOKEN'
  | 'FORBIDDEN'
  | 'EMAIL_NOT_VERIFIED'
  | 'CSRF_CHECK_FAILED'
  | 'NOT_FOUND'
  | 'SOLD_OUT'
  | 'SALES_CLOSED'
  | 'ORDER_EXPIRED'
  | 'INVALID_STATE'
  | 'IDEMPOTENCY_CONFLICT'
  | 'ALREADY_IN_WAITLIST'
  | 'NOT_SOLD_OUT'
  | 'OFFER_EXPIRED'
  | 'CANCELLATION_CLOSED'
  | 'CONFLICT'
  | 'LIMIT_EXCEEDED'
  | 'PAYMENT_METHOD_UNAVAILABLE'
  | 'AMOUNT_MISMATCH'
  | 'WAITLIST_DISABLED'
  | 'OFFLINE_CHECKIN_DISABLED'
  | 'PAYLOAD_TOO_LARGE'
  | 'UNSUPPORTED_MEDIA_TYPE'
  | 'RATE_LIMITED'
  | 'INTERNAL_ERROR';

export type ErrorDetails = Record<string, unknown>;

/** Erreur métier : son code et son message sont destinés au client. */
export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: ErrorDetails,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export interface FieldError {
  path: string;
  message: string;
}

export const errors = {
  validation: (fields: FieldError[], message = 'Données invalides.') =>
    new AppError(400, 'VALIDATION_ERROR', message, { fields }),
  unauthenticated: () => new AppError(401, 'UNAUTHENTICATED', 'Authentification requise.'),
  invalidCredentials: () => new AppError(401, 'INVALID_CREDENTIALS', 'Identifiants incorrects.'),
  invalidRefreshToken: () => new AppError(401, 'INVALID_REFRESH_TOKEN', 'Session expirée, veuillez vous reconnecter.'),
  forbidden: () => new AppError(403, 'FORBIDDEN', 'Droits insuffisants pour cette action.'),
  emailNotVerified: () => new AppError(403, 'EMAIL_NOT_VERIFIED', 'Veuillez d’abord vérifier votre adresse email.'),
  csrf: () => new AppError(403, 'CSRF_CHECK_FAILED', 'Requête refusée.'),
  notFound: () => new AppError(404, 'NOT_FOUND', 'Ressource introuvable.'),
  conflict: (message: string, details?: ErrorDetails) => new AppError(409, 'CONFLICT', message, details),
  state: (code: Extract<ErrorCode, 'SOLD_OUT' | 'SALES_CLOSED' | 'ORDER_EXPIRED' | 'INVALID_STATE' | 'IDEMPOTENCY_CONFLICT' | 'ALREADY_IN_WAITLIST' | 'NOT_SOLD_OUT' | 'OFFER_EXPIRED' | 'CANCELLATION_CLOSED' | 'WAITLIST_DISABLED' | 'OFFLINE_CHECKIN_DISABLED'>, message: string, details?: ErrorDetails) =>
    new AppError(409, code, message, details),
  unprocessable: (code: Extract<ErrorCode, 'LIMIT_EXCEEDED' | 'PAYMENT_METHOD_UNAVAILABLE' | 'AMOUNT_MISMATCH'>, message: string, details?: ErrorDetails) =>
    new AppError(422, code, message, details),
};

/** Une réponse ne respecte pas son schéma de sortie : bug serveur, jamais exposé tel quel. */
export class ResponseContractError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Réponse non conforme au contrat : ${problems.join(' ; ')}`);
    this.name = 'ResponseContractError';
  }
}
