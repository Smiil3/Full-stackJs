import { Router } from 'express';
import { requireOrgRole } from '../../middlewares/requireOrgRole.js';
import { endpoint } from '../../middlewares/validate.js';
import * as c from './controller.js';
import * as s from './schemas.js';
import { HTTP_STATUS } from '../../config/http.js';

/** Monté sous `/orgs/:orgId` (après requireAuth). */
export function orgsRouter(): Router {
  const r = Router({ mergeParams: true });
  r.get('/', requireOrgRole('SCANNER'), ...endpoint({ params: s.orgParams, response: s.orgResponse }, c.getOrgInfo));
  r.get('/settings', requireOrgRole('MANAGER'), ...endpoint({ params: s.orgParams, response: s.orgSettingsResponse }, c.getSettings));
  r.patch('/settings', requireOrgRole('OWNER'), ...endpoint({ params: s.orgParams, body: s.settingsPatchBody, response: s.orgSettingsResponse }, c.updateSettings));
  r.get('/members', requireOrgRole('MANAGER'), ...endpoint({ params: s.orgParams, response: s.itemsMembers }, c.listMembers));
  r.post('/members', requireOrgRole('OWNER'), ...endpoint({ params: s.orgParams, body: s.addMemberBody, response: s.memberResponse, status: HTTP_STATUS.CREATED }, c.addMember));
  r.patch('/members/:userId', requireOrgRole('OWNER'), ...endpoint({ params: s.memberParams, body: s.updateMemberBody, response: s.memberResponse }, c.updateMember));
  r.delete('/members/:userId', requireOrgRole('OWNER'), ...endpoint({ params: s.memberParams, response: null }, c.removeMember));
  r.get('/audit-log', requireOrgRole('OWNER'), ...endpoint({ params: s.orgParams, query: s.auditQuery, response: s.auditPageResponse }, c.auditLog));
  return r;
}
