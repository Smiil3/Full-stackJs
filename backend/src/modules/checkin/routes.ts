import { Router } from 'express';
import type { Limiters } from '../../middlewares/rateLimit.js';
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

/** Scan d'un événement, monté sous `/orgs/:orgId/events/:eventId/checkin`. */
export function eventCheckinRouter(limiters: Limiters): Router {
  const r = Router({ mergeParams: true });
  r.get('/snapshot', requireOrgRole('SCANNER'), ...endpoint({ params: s.eventParams, response: s.snapshotResponse }, c.snapshot));
  r.post('/scan', limiters.scan, requireOrgRole('SCANNER'), ...endpoint({ params: s.eventParams, body: s.scanBody, response: s.scanResponse }, c.scan));
  r.post('/sync', limiters.scan, requireOrgRole('SCANNER'), ...endpoint({ params: s.eventParams, body: s.syncBody, response: s.syncResponse }, c.sync));
  return r;
}
