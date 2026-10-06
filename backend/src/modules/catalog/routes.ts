import { Router } from 'express';
import { endpoint } from '../../middlewares/validate.js';
import * as c from './controller.js';
import * as s from './schemas.js';

/** Catalogue public (sans authentification). */
export function catalogRouter(): Router {
  const r = Router();
  r.get('/', ...endpoint({ query: s.catalogQuery, response: s.eventSummaryPage }, c.list));
  r.get('/:eventId', ...endpoint({ params: s.eventIdParams, response: s.eventPublicResponse }, c.get));
  return r;
}
