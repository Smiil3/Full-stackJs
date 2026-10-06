import { Router } from 'express';
import { requireAuth, requirePlatformAdmin } from '../../middlewares/auth.js';
import { endpoint } from '../../middlewares/validate.js';
import * as c from './controller.js';
import * as s from './schemas.js';
import { HTTP_STATUS } from '../../config/http.js';

/** Administration plateforme : un non-admin reçoit 404 (contrat 1.4). */
export function adminRouter(): Router {
  const r = Router();
  r.use(requireAuth, requirePlatformAdmin);
  r.get('/orgs', ...endpoint({ query: s.adminOrgsQuery, response: s.adminOrgList }, c.listOrgs));
  r.post('/orgs', ...endpoint({ body: s.createOrgBody, response: s.adminOrgResponse, status: HTTP_STATUS.CREATED }, c.createOrg));
  return r;
}
