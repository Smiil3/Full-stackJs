import type { Request, Response } from 'express';
import { getAuth } from '../../middlewares/auth.js';
import type { ValidatedInput } from '../../middlewares/validate.js';
import type { PageQuery } from '../../lib/schemas.js';
import * as service from './service.js';
import type { CreateOrgBody } from './schemas.js';
import * as refunds from '../refunds/service.js';
import type { OrphanRefundsQuery } from '../refunds/schemas.js';

type Empty = Record<string, never>;

export const listOrgs = ({ query }: ValidatedInput<Empty, PageQuery, Empty, Empty>) => service.listOrgs(query.page, query.pageSize);
export const createOrg = ({ body }: ValidatedInput<Empty, Empty, CreateOrgBody, Empty>, _q: Request, res: Response) =>
  service.createOrg(getAuth(res).userId, body);

export const listOrphanRefunds = ({ query }: ValidatedInput<Empty, OrphanRefundsQuery, Empty, Empty>) => refunds.listOrphanRefunds(query);
export const markOrphanRefundDone = (
  { params, body }: ValidatedInput<{ refundId: string }, Empty, { note: string }, Empty>, _q: Request, res: Response,
) => refunds.markOrphanDone(getAuth(res).userId, params.refundId, body.note);
