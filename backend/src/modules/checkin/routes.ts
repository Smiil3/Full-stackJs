import { Router } from 'express';
import { requireOrgRole } from '../../middlewares/requireOrgRole.js';
import { endpoint } from '../../middlewares/validate.js';
import * as c from './controller.js';
import * as s from './schemas.js';

/** Contrôle d'accès, monté sous `/orgs/:orgId/checkin`. */
export function orgCheckinRouter(): Router {
  const r = Router({ mergeParams: true });
  r.get('/events', requireOrgRole('SCANNER'), ...endpoint({ params: s.orgParams, response: s.checkinEventsResponse }, c.listEvents));
  return r;
}
