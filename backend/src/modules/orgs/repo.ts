import { getDb, type Tx } from '../../lib/db.js';

/** Tous les accès back-office prennent `orgId` et le placent dans chaque `where`. */
export function findOrg(orgId: string) {
  return getDb().organization.findUnique({ where: { id: orgId } });
}

export async function getSettings(tx: Tx, orgId: string) {
  // Toute organisation possède ses réglages ; on les crée par défaut si besoin (organisations historiques).
  return tx.organizationSettings.upsert({ where: { orgId }, create: { orgId }, update: {} });
}

/** Verrouille la ligne de réglages pour une lecture-modification-écriture sérialisée. */
export async function lockSettings(tx: Tx, orgId: string): Promise<void> {
  await tx.$queryRaw`SELECT "orgId" FROM "organization_settings" WHERE "orgId" = ${orgId}::uuid FOR UPDATE`;
}

export function listMembers(orgId: string) {
  return getDb().membership.findMany({
    where: { orgId },
    include: { user: { select: { email: true, displayName: true } } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
}

export function findMember(tx: Tx, orgId: string, userId: string) {
  return tx.membership.findUnique({
    where: { userId_orgId: { userId, orgId } },
    include: { user: { select: { email: true, displayName: true } } },
  });
}

/**
 * Rôle de l'acteur relu dans la transaction, adhésion verrouillée en partage (FOR SHARE) : une rétrogradation
 * ou un retrait concurrent (FOR UPDATE) attend la fin de la transaction, ou a déjà eu lieu et est vu.
 */
export async function lockActorRole(tx: Tx, orgId: string, userId: string): Promise<string | null> {
  const rows = await tx.$queryRaw<{ role: string }[]>`
    SELECT "role"::text AS "role" FROM "memberships" WHERE "orgId" = ${orgId}::uuid AND "userId" = ${userId}::uuid FOR SHARE`;
  return rows[0]?.role ?? null;
}

/** Verrouille les OWNER du collectif : empêche deux rétrogradations simultanées de supprimer le dernier OWNER. */
export async function lockOwners(tx: Tx, orgId: string): Promise<number> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "memberships" WHERE "orgId" = ${orgId}::uuid AND "role" = 'OWNER' FOR UPDATE`;
  return rows.length;
}

export function auditPage(orgId: string, page: number, pageSize: number) {
  const db = getDb();
  return Promise.all([
    db.auditLog.findMany({
      where: { orgId },
      include: { actor: { select: { email: true, isPlatformAdmin: true, memberships: { where: { orgId }, select: { id: true } } } } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    db.auditLog.count({ where: { orgId } }),
  ]);
}
