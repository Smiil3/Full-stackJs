import type { Request, Response } from 'express';
import { getOrg } from '../../middlewares/requireOrgRole.js';
import * as service from './service.js';

export const listEvents = (_i: unknown, _q: Request, res: Response) => service.listCheckinEvents(getOrg(res).orgId);
