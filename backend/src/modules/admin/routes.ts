import { Router } from 'express';
import { requireAuth, requirePlatformAdmin } from '../../middlewares/auth.js';
import { endpoint } from '../../middlewares/validate.js';
import * as c from './controller.js';
import * as s from './schemas.js';
import * as refunds from '../refunds/schemas.js';
import { HTTP_STATUS } from '../../config/http.js';

/** Administration plateforme : un non-admin reçoit 404 (contrat 1.4). */
export function adminRouter(): Router {
  const r = Router();
  r.use(requireAuth, requirePlatformAdmin);
  r.get('/orgs', ...endpoint({ query: s.adminOrgsQuery, response: s.adminOrgList }, c.listOrgs));
  r.post('/orgs', ...endpoint({ body: s.createOrgBody, response: s.adminOrgResponse, status: HTTP_STATUS.CREATED }, c.createOrg));
  // Remboursements sans commande (paiements inattendus) : visibles et traitables ici seulement (contrat 1.17 §8).
  r.get('/refunds', ...endpoint({ query: refunds.orphanRefundsQuery, response: refunds.refundAdminPage }, c.listOrphanRefunds));
  r.post('/refunds/:refundId/mark-done', ...endpoint({ params: refunds.orphanRefundParams, body: refunds.markDoneBody, response: refunds.refundAdminResponse },
    c.markOrphanRefundDone));
  // Commandes écartées de l'expiration automatique (contrat 1.17 §8, audit B2).
  r.get('/stuck-orders', ...endpoint({ query: s.adminOrgsQuery, response: s.stuckOrderPage }, c.listStuckOrders));
  r.post('/stuck-orders/:orderId/retry', ...endpoint({ params: s.stuckOrderParams, response: s.stuckOrderResponse }, c.retryStuckOrder));
  return r;
}
