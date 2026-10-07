import { Router, type Request, type Response } from 'express';
import Joi from 'joi';
import { getAuth } from '../../middlewares/auth.js';
import { getOrg, requireOrgRole } from '../../middlewares/requireOrgRole.js';
import { endpoint, validate, type ValidatedInput } from '../../middlewares/validate.js';
import { isoDateOutput, uuid, uuidStrict } from '../../lib/schemas.js';
import { eventStats } from './stats.js';
import { streamAttendees } from './attendees.js';
import type { Limiters } from '../../middlewares/rateLimit.js';

type Empty = Record<string, never>;
const params = Joi.object<{ orgId: string; eventId: string }>({ orgId: uuid.required(), eventId: uuid.required() });
const int = Joi.number().integer();
const statsResponse = Joi.object({
  eventId: uuidStrict, generatedAt: isoDateOutput, currency: Joi.string().valid('EUR'),
  ticketTypes: Joi.array().items(Joi.object({
    ticketTypeId: uuidStrict, name: Joi.string(), capacity: int, sold: int, held: int, remaining: int, checkedIn: int, revenueCents: int, refundedCents: int,
  })),
  totals: Joi.object({
    capacity: int, sold: int, held: int, remaining: int, checkedIn: int, revenueCents: int, refundedCents: int, serviceFeeCents: int, refundsToProcess: int,
  }),
  ordersByStatus: Joi.object({
    PENDING_PAYMENT: int, AWAITING_TRANSFER: int, PAID: int, EXPIRED: int, CANCELLED: int, REFUNDED: int,
  }),
  waitlistWaiting: int,
});

/** Statistiques et export, montés sous `/orgs/:orgId/events/:eventId`. */
export function reportsRouter(limiters: Limiters): Router {
  const r = Router({ mergeParams: true });
  r.get('/stats', requireOrgRole('MANAGER'), ...endpoint({ params, response: statsResponse },
    ({ params: p }: ValidatedInput<{ orgId: string; eventId: string }, Empty, Empty, Empty>, _q: Request, res: Response) => eventStats(getOrg(res).orgId, p.eventId)));
  // Réponse CSV en flux : validation d'entrée standard, sortie construite cellule par cellule (pas de JSON).
  r.get('/attendees.csv', requireOrgRole('MANAGER'), limiters.exportPerUser, validate({ params }), async (_req, res) => {
    const input = res.locals['input'] as ValidatedInput<{ orgId: string; eventId: string }, Empty, Empty, Empty>;
    await streamAttendees(getOrg(res).orgId, getAuth(res).userId, input.params.eventId, res);
  });
  return r;
}
