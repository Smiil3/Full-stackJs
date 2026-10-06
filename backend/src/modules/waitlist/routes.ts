import { Router, type Request, type Response } from 'express';
import { getAuth, requireAuth, requireVerifiedEmail } from '../../middlewares/auth.js';
import type { Limiters } from '../../middlewares/rateLimit.js';
import { endpoint, type ValidatedInput } from '../../middlewares/validate.js';
import { orderResponse } from '../orders/schemas.js';
import * as service from './service.js';
import * as s from './schemas.js';
import { HTTP_STATUS } from '../../config/http.js';

type Empty = Record<string, never>;

/** `POST /events/:eventId/ticket-types/:ticketTypeId/waitlist` (monté sous /events). */
export function joinWaitlistRouter(limiters: Limiters): Router {
  const r = Router();
  r.post('/:eventId/ticket-types/:ticketTypeId/waitlist', requireAuth, limiters.ordersPerUser, requireVerifiedEmail,
    ...endpoint({ params: s.joinParams, body: s.joinBody, response: s.waitlistEntryResponse, status: HTTP_STATUS.CREATED },
      ({ params, body }: ValidatedInput<{ eventId: string; ticketTypeId: string }, Empty, { quantity: number }, Empty>, _q: Request, res: Response) =>
        service.join(getAuth(res).userId, params.eventId, params.ticketTypeId, body.quantity)));
  return r;
}

/** `/waitlist/:entryId` (quitter, accepter). */
export function waitlistRouter(limiters: Limiters): Router {
  const r = Router();
  r.use(requireAuth);
  r.delete('/:entryId', ...endpoint({ params: s.entryParams, response: null },
    ({ params }: ValidatedInput<{ entryId: string }, Empty, Empty, Empty>, _q: Request, res: Response) => service.leave(getAuth(res).userId, params.entryId)));
  r.post('/:entryId/accept', limiters.ordersPerUser, ...endpoint({ params: s.entryParams, response: orderResponse, status: HTTP_STATUS.CREATED },
    ({ params }: ValidatedInput<{ entryId: string }, Empty, Empty, Empty>, _q: Request, res: Response) => service.accept(getAuth(res).userId, params.entryId)));
  return r;
}

export const myWaitlist = (_i: unknown, _q: Request, res: Response) => service.myWaitlist(getAuth(res).userId);
