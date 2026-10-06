import { Router } from 'express';
import { requireOrgRole } from '../../middlewares/requireOrgRole.js';
import { endpoint } from '../../middlewares/validate.js';
import * as c from './controller.js';
import * as s from './schemas.js';

/** Événements et types de places d'un collectif, montés sous `/orgs/:orgId/events`. */
export function orgEventsRouter(): Router {
  const r = Router({ mergeParams: true });
  r.get('/', requireOrgRole('SCANNER'), ...endpoint({ params: s.orgParams, query: s.eventListQuery, response: s.eventAdminPage }, c.list));
  r.post('/', requireOrgRole('MANAGER'), ...endpoint({ params: s.orgParams, body: s.eventCreateBody, response: s.eventAdminResponse, status: 201 }, c.create));
  r.get('/:eventId', requireOrgRole('SCANNER'), ...endpoint({ params: s.orgEventParams, response: s.eventAdminResponse }, c.get));
  r.patch('/:eventId', requireOrgRole('MANAGER'), ...endpoint({ params: s.orgEventParams, body: s.eventPatchBody, response: s.eventAdminResponse }, c.update));
  r.post('/:eventId/publish', requireOrgRole('MANAGER'), ...endpoint({ params: s.orgEventParams, response: s.eventAdminResponse }, c.publish));
  r.post('/:eventId/ticket-types', requireOrgRole('MANAGER'),
    ...endpoint({ params: s.orgEventParams, body: s.ticketTypeCreateBody, response: s.ticketTypeAdminResponse, status: 201 }, c.createTicketType));
  r.patch('/:eventId/ticket-types/:ticketTypeId', requireOrgRole('MANAGER'),
    ...endpoint({ params: s.ticketTypeParams, body: s.ticketTypePatchBody, response: s.ticketTypeAdminResponse }, c.updateTicketType));
  r.delete('/:eventId/ticket-types/:ticketTypeId', requireOrgRole('MANAGER'),
    ...endpoint({ params: s.ticketTypeParams, response: null }, c.deleteTicketType));
  return r;
}
