import type { Role } from '../generated/prisma/client.js';
import type { Tx } from './db.js';
import { errors } from './errors.js';

const RANK: Record<Role, number> = { SCANNER: 1, MANAGER: 2, OWNER: 3 };

/**
 * Rôle de l'acteur relu DANS la transaction, adhésion verrouillée en partage (FOR SHARE) : un rôle retiré ou
 * abaissé entre le contrôle du middleware et la transaction est vu, et une rétrogradation concurrente attend
 * la fin de l'action (audit B12). À appeler EN PREMIER dans la transaction (avant events / settings) ; pour les
 * opérations sur les membres, juste APRÈS `lockOwners` (qui verrouille déjà les OWNER en écriture).
 * Non-membre ⇒ 404 ; rôle insuffisant ⇒ 403. Renvoie le rôle relu (à utiliser à la place de celui du middleware).
 */
export async function requireRoleInTx(tx: Tx, orgId: string, userId: string, minRole: Role): Promise<Role> {
  const rows = await tx.$queryRaw<{ role: Role }[]>`
    SELECT "role" FROM "memberships" WHERE "orgId" = ${orgId}::uuid AND "userId" = ${userId}::uuid FOR SHARE`;
  const role = rows[0]?.role;
  if (role === undefined) throw errors.notFound();
  if (RANK[role] < RANK[minRole]) throw errors.forbidden();
  return role;
}
