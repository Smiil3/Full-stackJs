import { Router } from 'express';
import { requireAuth, requireVerifiedEmail } from '../../middlewares/auth.js';
import type { Limiters } from '../../middlewares/rateLimit.js';
import { endpoint } from '../../middlewares/validate.js';
import * as c from './controller.js';
import * as s from './schemas.js';

export function ordersRouter(limiters: Limiters): Router {
  const r = Router();
  r.use(requireAuth);
  r.post('/', limiters.orders, limiters.ordersPerUser, requireVerifiedEmail,
    ...endpoint({ headers: s.idempotencyHeaders, body: s.createOrderBody, response: s.orderResponse, status: 201 }, c.create));
  r.get('/', ...endpoint({ query: s.ordersQuery, response: s.orderPage }, c.list));
  r.get('/:orderId', limiters.orderPoll, ...endpoint({ params: s.orderParams, response: s.orderResponse }, c.get));
  r.post('/:orderId/cancel', ...endpoint({ params: s.orderParams, response: s.orderResponse }, c.cancel));
  r.post('/:orderId/checkout', limiters.orders, limiters.ordersPerUser, ...endpoint({ params: s.orderParams, response: s.checkoutResponse }, c.checkout));
  return r;
}
