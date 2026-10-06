import type { Request, Response } from 'express';
import { getAuth } from '../../middlewares/auth.js';
import { getOrg } from '../../middlewares/requireOrgRole.js';
import type { ValidatedInput } from '../../middlewares/validate.js';
import * as service from './service.js';
import type { ScanBody, SyncBody } from './schemas.js';

type Empty = Record<string, never>;
type EventP = { orgId: string; eventId: string };

export const listEvents = (_i: unknown, _q: Request, res: Response) => service.listCheckinEvents(getOrg(res).orgId);
export const snapshot = ({ params }: ValidatedInput<EventP, Empty, Empty, Empty>, _q: Request, res: Response) =>
  service.snapshot(getOrg(res).orgId, params.eventId);
export const scan = ({ params, body }: ValidatedInput<EventP, Empty, ScanBody, Empty>, _q: Request, res: Response) =>
  service.scan(getOrg(res).orgId, params.eventId, getAuth(res).userId, body);
export const sync = ({ params, body }: ValidatedInput<EventP, Empty, SyncBody, Empty>, _q: Request, res: Response) =>
  service.sync(getOrg(res).orgId, params.eventId, getAuth(res).userId, body);
