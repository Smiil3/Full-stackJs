import { Router, type Request, type Response } from 'express';
import { requireAuth, getAuth } from '../../middlewares/auth.js';
import { endpoint } from '../../middlewares/validate.js';
import { myTickets } from './service.js';
import { myTicketsResponse } from './schemas.js';
import { myWaitlist } from '../waitlist/routes.js';
import { myWaitlistResponse } from '../waitlist/schemas.js';

/** Monté sous `/me`. */
export function meRouter(): Router {
  const r = Router();
  r.use(requireAuth);
  r.get('/tickets', ...endpoint({ response: myTicketsResponse }, (_i: unknown, _q: Request, res: Response) => myTickets(getAuth(res).userId)));
  r.get('/waitlist', ...endpoint({ response: myWaitlistResponse }, myWaitlist));
  return r;
}
