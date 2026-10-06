import type { RequestHandler, Response } from 'express';
import type { Role } from '../generated/prisma/client.js';
import { getDb } from '../lib/db.js';
import { errors } from '../lib/errors.js';
import { getAuth } from './auth.js';

const RANK: Record<Role, number> = { SCANNER: 1, MANAGER: 2, OWNER: 3 };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface OrgContext {
  orgId: string;
  role: Role;
}

/**
 * Contrôle d'accès back-office : l'adhésion est relue EN BASE à chaque requête (jamais depuis le JWT).
 * Non-membre (ou collectif inexistant) ⇒ 404 ; membre au rôle insuffisant ⇒ 403.
 */
export function requireOrgRole(minRole: Role): RequestHandler {
  return async (req, res, next) => {
    const auth = getAuth(res);
    const orgId = req.params['orgId'];
    if (typeof orgId !== 'string' || !UUID_RE.test(orgId)) throw errors.notFound();
    const membership = await getDb().membership.findUnique({
      where: { userId_orgId: { userId: auth.userId, orgId } },
      select: { role: true },
    });
    if (!membership) throw errors.notFound();
    if (RANK[membership.role] < RANK[minRole]) throw errors.forbidden();
    res.locals['org'] = { orgId, role: membership.role } satisfies OrgContext;
    next();
  };
}

export function getOrg(res: Response): OrgContext {
  const org = res.locals['org'] as OrgContext | undefined;
  if (!org) throw errors.notFound();
  return org;
}
