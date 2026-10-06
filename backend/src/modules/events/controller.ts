import type { Request, Response } from 'express';
import { getAuth } from '../../middlewares/auth.js';
import { getOrg } from '../../middlewares/requireOrgRole.js';
import type { ValidatedInput } from '../../middlewares/validate.js';
import * as service from './service.js';
import type { EventCreateBody, EventListQuery, EventPatchBody, TicketTypeBody, TicketTypePatchBody } from './schemas.js';

type Empty = Record<string, never>;
type OrgP = { orgId: string };
type EventP = { orgId: string; eventId: string };
type TtP = { orgId: string; eventId: string; ticketTypeId: string };
type In<P, Q, B> = ValidatedInput<P, Q, B, Empty>;

// orgId : toujours celui contrôlé par requireOrgRole ; les repos le placent dans chaque `where`.
export const list = ({ query }: In<OrgP, EventListQuery, Empty>, _q: Request, res: Response) =>
  service.listEvents(getOrg(res).orgId, query.status, query.page, query.pageSize);
export const get = ({ params }: In<EventP, Empty, Empty>, _q: Request, res: Response) => service.getEvent(getOrg(res).orgId, params.eventId);
export const create = ({ body }: In<OrgP, Empty, EventCreateBody>, _q: Request, res: Response) =>
  service.createEvent(getOrg(res).orgId, getAuth(res).userId, body);
export const update = ({ params, body }: In<EventP, Empty, EventPatchBody>, _q: Request, res: Response) =>
  service.updateEvent(getOrg(res).orgId, { userId: getAuth(res).userId, role: getOrg(res).role }, params.eventId, body);
export const publish = ({ params }: In<EventP, Empty, Empty>, _q: Request, res: Response) =>
  service.publishEvent(getOrg(res).orgId, getAuth(res).userId, params.eventId);
export const createTicketType = ({ params, body }: In<EventP, Empty, TicketTypeBody>, _q: Request, res: Response) =>
  service.createTicketType(getOrg(res).orgId, getAuth(res).userId, params.eventId, body);
export const updateTicketType = ({ params, body }: In<TtP, Empty, TicketTypePatchBody>, _q: Request, res: Response) =>
  service.updateTicketType(getOrg(res).orgId, getAuth(res).userId, params.eventId, params.ticketTypeId, body);
export const deleteTicketType = ({ params }: In<TtP, Empty, Empty>, _q: Request, res: Response) =>
  service.deleteTicketType(getOrg(res).orgId, getAuth(res).userId, params.eventId, params.ticketTypeId);
