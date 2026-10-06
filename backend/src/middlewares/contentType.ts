import type { RequestHandler } from 'express';
import { AppError } from '../lib/errors.js';

const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function hasBody(headers: Record<string, string | string[] | undefined>): boolean {
  const length = headers['content-length'];
  return headers['transfer-encoding'] !== undefined || (typeof length === 'string' && length !== '0');
}

/** Un corps de requête doit être du JSON : tout autre Content-Type ⇒ 415 UNSUPPORTED_MEDIA_TYPE. */
export const requireJsonContentType: RequestHandler = (req, _res, next) => {
  if (BODY_METHODS.has(req.method) && hasBody(req.headers) && !req.is('application/json')) {
    throw new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Le corps de la requête doit être au format JSON.');
  }
  next();
};
