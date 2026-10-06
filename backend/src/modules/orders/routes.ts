import { Router } from 'express';
import { requireAuth, requireVerifiedEmail } from '../../middlewares/auth.js';
import type { Limiters } from '../../middlewares/rateLimit.js';
import { endpoint } from '../../middlewares/validate.js';
import * as c from './controller.js';
import * as s from './schemas.js';

export function ordersRouter(limiters: Limiters): Router {
  const r = Router();
  r.use(requireAuth);
  r.post('/', limiters.orders, requireVerifiedEmail,
    ...endpoint({ headers: s.idempotencyHeaders, body: s.createOrderBody, response: s.orderResponse, status: 201 }, c.create));
  r.get('/', ...endpoint({ query: s.ordersQuery, response: s.orderPage }, c.list));
  r.get('/:orderId', ...endpoint({ params: s.orderParams, response: s.orderResponse }, c.get));
  r.post('/:orderId/checkout', limiters.orders, ...endpoint({ params: s.orderParams, response: s.checkoutResponse }, c.checkout));
  return r;
}
