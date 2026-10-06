import type { ErrorRequestHandler, RequestHandler } from 'express';
import { Prisma } from '../generated/prisma/client.js';
import { AppError, ResponseContractError } from '../lib/errors.js';

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
  res.status(404).json(body('NOT_FOUND', 'Ressource introuvable.'));
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
    if (err.status >= 500) req.log.error({ err }, 'erreur applicative');
    res.status(err.status).json(body(err.code, err.message, err.details));
    return;
  }
  if (isBodyParserError(err)) {
    if (err.type === 'entity.too.large') {
      res.status(413).json(body('VALIDATION_ERROR', 'Corps de requête trop volumineux.'));
      return;
    }
    if (err.status === 400 || err.type === 'entity.parse.failed' || err.type === 'encoding.unsupported' || err.type === 'charset.unsupported') {
      res.status(400).json(body('VALIDATION_ERROR', 'Corps de requête JSON invalide.'));
      return;
    }
  }
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2002') {
      req.log.warn({ prismaCode: err.code }, 'violation de contrainte d’unicité');
      res.status(409).json(body('CONFLICT', 'Cette ressource existe déjà.'));
      return;
    }
    if (err.code === 'P2025') {
      res.status(404).json(body('NOT_FOUND', 'Ressource introuvable.'));
      return;
    }
    if (err.code === 'P2034') {
      req.log.warn({ prismaCode: err.code }, 'conflit de transaction');
      res.status(409).json(body('CONFLICT', 'Conflit d’accès concurrent, veuillez réessayer.'));
      return;
    }
  }
  if (err instanceof ResponseContractError) {
    req.log.error({ problems: err.problems }, 'réponse non conforme au contrat');
  } else {
    req.log.error({ err }, 'erreur non gérée');
  }
  res.status(500).json(body('INTERNAL_ERROR', 'Une erreur interne est survenue.'));
};
