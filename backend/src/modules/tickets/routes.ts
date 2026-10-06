import { Router, type Request, type Response } from 'express';
import { requireAuth, getAuth } from '../../middlewares/auth.js';
import { endpoint } from '../../middlewares/validate.js';
import { myTickets } from './service.js';
import { myTicketsResponse } from './schemas.js';

/** Monté sous `/me`. */
export function meRouter(): Router {
  const r = Router();
  r.use(requireAuth);
  r.get('/tickets', ...endpoint({ response: myTicketsResponse }, (_i: unknown, _q: Request, res: Response) => myTickets(getAuth(res).userId)));
  return r;
}
