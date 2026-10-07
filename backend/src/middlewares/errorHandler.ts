import type { ErrorRequestHandler, RequestHandler } from 'express';
import { Prisma } from '../generated/prisma/client.js';
import { AppError, ResponseContractError } from '../lib/errors.js';
import { isTransientTxError } from '../lib/txRetry.js';
import { HTTP_CLIENT_ERROR_MIN, HTTP_SERVER_ERROR_MIN, HTTP_STATUS } from '../config/http.js';

interface ErrorBody {
  error: { code: string; message: string; details?: Record<string, unknown> };
}

function body(code: string, message: string, details?: Record<string, unknown>): ErrorBody {
  return details === undefined ? { error: { code, message } } : { error: { code, message, details } };
}

function isBodyParserError(err: unknown): err is { type: string; status: number } {
  return typeof err === 'object' && err !== null && 'type' in err && typeof err.type === 'string'
    && 'status' in err && typeof err.status === 'number';
}

/** 404 JSON pour toute route inconnue. */
export const notFoundHandler: RequestHandler = (_req, res) => {
  res.status(HTTP_STATUS.NOT_FOUND).json(body('NOT_FOUND', 'Ressource introuvable.'));
};

/**
 * Gestionnaire d'erreurs centralisé : aucune stack, aucun message Prisma / SQL n'est renvoyé au client.
 * Les détails techniques ne vont que dans les logs (avec le requestId pour corréler).
 */
export const errorHandler: ErrorRequestHandler = (err: unknown, req, res, _next) => {
  if (res.headersSent) {
    req.log.error({ err }, 'erreur après envoi des en-têtes');
    res.destroy();
    return;
  }
  if (err instanceof AppError) {
    if (err.status >= HTTP_SERVER_ERROR_MIN) req.log.error({ err }, 'erreur applicative');
    // Délai conseillé (limites de requêtes, prestataire de paiement injoignable) : en-tête Retry-After, pas dans le corps.
    const retryAfter = err.details?.['retryAfterSeconds'];
    if (typeof retryAfter === 'number') {
      res.setHeader('Retry-After', String(retryAfter));
      res.status(err.status).json(body(err.code, err.message));
      return;
    }
    res.status(err.status).json(body(err.code, err.message, err.details));
    return;
  }
  if (isBodyParserError(err) && err.status >= HTTP_CLIENT_ERROR_MIN && err.status < HTTP_SERVER_ERROR_MIN) {
    // Erreurs du parseur de corps : le statut d'origine est conservé, avec un code du contrat.
    if (err.status === HTTP_STATUS.PAYLOAD_TOO_LARGE) {
      res.status(HTTP_STATUS.PAYLOAD_TOO_LARGE).json(body('PAYLOAD_TOO_LARGE', 'Corps de requête trop volumineux.'));
    } else if (err.status === HTTP_STATUS.UNSUPPORTED_MEDIA_TYPE) {
      res.status(HTTP_STATUS.UNSUPPORTED_MEDIA_TYPE).json(body('UNSUPPORTED_MEDIA_TYPE', 'Encodage du corps de requête non supporté.'));
    } else {
      res.status(err.status).json(body('VALIDATION_ERROR', 'Corps de requête JSON invalide.'));
    }
    return;
  }
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2002') {
      req.log.warn({ prismaCode: err.code }, 'violation de contrainte d’unicité');
      res.status(HTTP_STATUS.CONFLICT).json(body('CONFLICT', 'Cette ressource existe déjà.'));
      return;
    }
    if (err.code === 'P2003') {
      // Clé étrangère : ressource supprimée ou encore référencée par une opération concurrente.
      req.log.warn({ prismaCode: err.code }, 'violation de clé étrangère');
      res.status(HTTP_STATUS.CONFLICT).json(body('CONFLICT', 'Cette ressource est liée à d’autres données ou a été modifiée entre-temps.'));
      return;
    }
    if (err.code === 'P2025') {
      res.status(HTTP_STATUS.NOT_FOUND).json(body('NOT_FOUND', 'Ressource introuvable.'));
      return;
    }
    if (err.code === 'P2034') {
      req.log.warn({ prismaCode: err.code }, 'conflit de transaction');
      res.status(HTTP_STATUS.CONFLICT).json(body('CONFLICT', 'Conflit d’accès concurrent, veuillez réessayer.'));
      return;
    }
  }
  if (isTransientTxError(err)) {
    // Interblocage / sérialisation hors des chemins rejoués : jamais un 500.
    req.log.warn({ err }, 'conflit transactionnel transitoire');
    res.status(HTTP_STATUS.CONFLICT).json(body('CONFLICT', 'Conflit d’accès concurrent, veuillez réessayer.'));
    return;
  }
  if (err instanceof ResponseContractError) {
    req.log.error({ problems: err.problems }, 'réponse non conforme au contrat');
  } else {
    req.log.error({ err }, 'erreur non gérée');
  }
  res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json(body('INTERNAL_ERROR', 'Une erreur interne est survenue.'));
};
