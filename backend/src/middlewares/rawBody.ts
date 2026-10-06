import type { RequestHandler } from 'express';
import { errors } from '../lib/errors.js';

/**
 * Webhook : récupère le corps BRUT (Buffer posé par express.raw) dans res.locals.rawBody.
 * Seul endroit, avec validate.ts et requireOrgRole.ts, autorisé à lire la requête brute.
 */
export const captureRawBody: RequestHandler = (req, res, next) => {
  const body: unknown = req.body;
  if (!Buffer.isBuffer(body) || body.length === 0) throw errors.validation([{ path: 'body', message: 'Corps brut JSON attendu.' }]);
  res.locals['rawBody'] = body;
  next();
};
