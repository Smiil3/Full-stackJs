import type { Request, Response } from 'express';
import { getAuth } from '../../middlewares/auth.js';
import { getOrg } from '../../middlewares/requireOrgRole.js';
import type { ValidatedInput } from '../../middlewares/validate.js';
import type { PageQuery } from '../../lib/schemas.js';
import * as service from './service.js';
import type { AddMemberBody, RoleName, SettingsPatch } from './schemas.js';

type Empty = Record<string, never>;
type OrgP = { orgId: string };
type MemberP = { orgId: string; userId: string };

// L'orgId utilisé est TOUJOURS celui contrôlé par requireOrgRole (adhésion vérifiée en base).
export const getOrgInfo = (_i: ValidatedInput<OrgP, Empty, Empty, Empty>, _q: Request, res: Response) => service.getOrg(getOrg(res).orgId);
export const getSettings = (_i: ValidatedInput<OrgP, Empty, Empty, Empty>, _q: Request, res: Response) => service.getSettings(getOrg(res).orgId);
export const updateSettings = ({ body }: ValidatedInput<OrgP, Empty, SettingsPatch, Empty>, _q: Request, res: Response) =>
  service.updateSettings(getOrg(res).orgId, getAuth(res).userId, body);
export const listMembers = (_i: ValidatedInput<OrgP, Empty, Empty, Empty>, _q: Request, res: Response) => service.listMembers(getOrg(res).orgId);
export const addMember = ({ body }: ValidatedInput<OrgP, Empty, AddMemberBody, Empty>, _q: Request, res: Response) =>
  service.addMember(getOrg(res).orgId, getAuth(res).userId, body.email, body.role);
export const updateMember = ({ params, body }: ValidatedInput<MemberP, Empty, { role: RoleName }, Empty>, _q: Request, res: Response) =>
  service.updateMemberRole(getOrg(res).orgId, getAuth(res).userId, params.userId, body.role);
export const removeMember = ({ params }: ValidatedInput<MemberP, Empty, Empty, Empty>, _q: Request, res: Response) =>
  service.removeMember(getOrg(res).orgId, getAuth(res).userId, params.userId);
export const auditLog = ({ query }: ValidatedInput<OrgP, PageQuery, Empty, Empty>, _q: Request, res: Response) =>
  service.auditLog(getOrg(res).orgId, query.page, query.pageSize);
