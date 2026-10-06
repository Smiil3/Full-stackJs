import { Router, type Request, type Response } from 'express';
import { getAuth } from '../../middlewares/auth.js';
import { getOrg, requireOrgRole } from '../../middlewares/requireOrgRole.js';
import { endpoint, type ValidatedInput } from '../../middlewares/validate.js';
import * as service from './service.js';
import * as s from './schemas.js';

type Empty = Record<string, never>;

/** Suivi des remboursements (MANAGER+), monté sous `/orgs/:orgId/refunds`. */
export function orgRefundsRouter(): Router {
  const r = Router({ mergeParams: true });
  r.get('/', requireOrgRole('MANAGER'), ...endpoint({ params: s.orgParams, query: s.refundsQuery, response: s.refundAdminPage },
    ({ query }: ValidatedInput<{ orgId: string }, s.RefundsQuery, Empty, Empty>, _q: Request, res: Response) => service.listRefunds(getOrg(res).orgId, query)));
  r.post('/:refundId/mark-done', requireOrgRole('MANAGER'), ...endpoint({ params: s.refundParams, body: s.markDoneBody, response: s.refundAdminResponse },
    ({ params, body }: ValidatedInput<{ orgId: string; refundId: string }, Empty, { note: string }, Empty>, _q: Request, res: Response) =>
      service.markDone(getOrg(res).orgId, getAuth(res).userId, params.refundId, body.note)));
  return r;
}
