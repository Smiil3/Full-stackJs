import { lookup } from '../lib/lookup';
import type { Membership, OrgRole, User } from '../api/types';

const RANK: Record<OrgRole, number> = { SCANNER: 1, MANAGER: 2, OWNER: 3 };

/** OWNER ⊃ MANAGER ⊃ SCANNER. Contrôle d'AFFICHAGE uniquement : l'API vérifie à chaque requête. */
export function roleAtLeast(role: OrgRole, min: OrgRole): boolean {
  return (lookup(RANK, role) ?? 0) >= RANK[min];
}

export function membershipFor(user: User | null, orgId: string | undefined): Membership | undefined {
  if (!user || !orgId) return undefined;
  return user.memberships.find((m) => m.orgId === orgId);
}

export function hasOrgRole(user: User | null, orgId: string | undefined, min: OrgRole): boolean {
  const m = membershipFor(user, orgId);
  return m !== undefined && roleAtLeast(m.role, min);
}

export const ROLE_LABELS: Record<OrgRole, string> = { OWNER: 'Propriétaire', MANAGER: 'Gestionnaire', SCANNER: 'Contrôle d’accès' };
