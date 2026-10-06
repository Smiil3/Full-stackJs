import { Router } from 'express';
import { requireOrgRole } from '../../middlewares/requireOrgRole.js';
import { endpoint } from '../../middlewares/validate.js';
import * as c from './controller.js';
import * as s from './schemas.js';

/** Commandes vues par le collectif, montées sous `/orgs/:orgId`. */
export function orgOrdersRouter(): Router {
  const r = Router({ mergeParams: true });
  r.get('/events/:eventId/orders', requireOrgRole('MANAGER'),
    ...endpoint({ params: s.eventParams, query: s.eventOrdersQuery, response: s.orderAdminPage }, c.list));
  r.post('/orders/:orderId/confirm-transfer', requireOrgRole('MANAGER'),
    ...endpoint({ params: s.orderParams, body: s.confirmTransferBody, response: s.orderAdminResponse }, c.confirmTransfer));
  return r;
}
