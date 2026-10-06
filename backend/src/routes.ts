import { Router } from 'express';
import type { Limiters } from './middlewares/rateLimit.js';
import { authRouter } from './modules/auth/routes.js';
import { requireAuth } from './middlewares/auth.js';
import { orgsRouter } from './modules/orgs/routes.js';
import { orgEventsRouter } from './modules/events/routes.js';
import { adminRouter } from './modules/admin/routes.js';
import { catalogRouter } from './modules/catalog/routes.js';

/** Routeur principal `/api/v1` : chaque module y monte ses routes. */
export function buildApiRouter(limiters: Limiters): Router {
  const router = Router();
  router.use('/auth', authRouter(limiters));
  router.use('/events', catalogRouter());
  router.use('/admin', adminRouter());
  router.use('/orgs/:orgId', requireAuth);
  router.use('/orgs/:orgId/events', orgEventsRouter());
  router.use('/orgs/:orgId', orgsRouter());
  return router;
}

/** Routes recevant un corps brut (webhook PSP). */
export function buildWebhookRouter(): Router {
  const router = Router();
  return router;
}
