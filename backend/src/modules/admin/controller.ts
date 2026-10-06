import type { Request, Response } from 'express';
import { getAuth } from '../../middlewares/auth.js';
import type { ValidatedInput } from '../../middlewares/validate.js';
import * as service from './service.js';
import type { CreateOrgBody } from './schemas.js';

type Empty = Record<string, never>;

export const listOrgs = () => service.listOrgs();
export const createOrg = ({ body }: ValidatedInput<Empty, Empty, CreateOrgBody, Empty>, _q: Request, res: Response) =>
  service.createOrg(getAuth(res).userId, body);
