import type { RequestHandler } from 'express';
import { getEnv } from '../config/env.js';
import { errors } from '../lib/errors.js';

/**
 * Anti-CSRF des endpoints authentifiés par cookie (refresh / logout) :
 * en-tête personnalisé (impossible à poser par un formulaire cross-site sans preflight CORS)
 * ET Origin dans l'allowlist. Le cookie est en plus SameSite=Strict.
 */
export const requireCsrfHeaders: RequestHandler = (req, _res, next) => {
  const origin = req.headers.origin;
  if (req.headers['x-requested-with'] !== 'nuits-web' || typeof origin !== 'string' || origin !== getEnv().frontUrl) {
    throw errors.csrf();
  }
  next();
};
