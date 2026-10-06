import type { Request, Response } from 'express';
import { getAuth } from '../../middlewares/auth.js';
import type { ValidatedInput } from '../../middlewares/validate.js';
import type { PageQuery } from '../../lib/schemas.js';
import * as service from './service.js';
import type { CreateOrderBody } from './schemas.js';

type Empty = Record<string, never>;

export async function create(
  { body, headers }: ValidatedInput<Empty, Empty, CreateOrderBody, { 'idempotency-key': string }>,
  _req: Request,
  res: Response,
) {
  const result = await service.createOrder(getAuth(res).userId, headers['idempotency-key'], body);
  // Rejeu de la même requête : même commande, 200 (et non 201).
  if (result.replayed) res.locals['status'] = 200;
  return result.order;
}

export const list = ({ query }: ValidatedInput<Empty, PageQuery, Empty, Empty>, _q: Request, res: Response) =>
  service.listOrders(getAuth(res).userId, query.page, query.pageSize);

export const get = ({ params }: ValidatedInput<{ orderId: string }, Empty, Empty, Empty>, _q: Request, res: Response) =>
  service.getOrder(getAuth(res).userId, params.orderId);
