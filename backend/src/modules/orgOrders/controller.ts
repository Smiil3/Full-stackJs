import type { Request, Response } from 'express';
import { getAuth } from '../../middlewares/auth.js';
import { getOrg } from '../../middlewares/requireOrgRole.js';
import type { ValidatedInput } from '../../middlewares/validate.js';
import * as service from './service.js';
import type { EventOrdersQuery } from './schemas.js';

type Empty = Record<string, never>;

export const list = ({ params, query }: ValidatedInput<{ orgId: string; eventId: string }, EventOrdersQuery, Empty, Empty>, _q: Request, res: Response) =>
  service.listEventOrders(getOrg(res).orgId, params.eventId, query);

export const confirmTransfer = (
  { params, body }: ValidatedInput<{ orgId: string; orderId: string }, Empty, { receivedAmountCents: number }, Empty>,
  _q: Request,
  res: Response,
) => service.confirmTransfer(getOrg(res).orgId, getAuth(res).userId, params.orderId, body.receivedAmountCents);
