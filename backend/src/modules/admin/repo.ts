import { getDb } from '../../lib/db.js';

/** Tri déterministe : nom puis id. */
export function listOrgs(page: number, pageSize: number) {
  const db = getDb();
  return Promise.all([
    db.organization.findMany({
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      select: { id: true, name: true, slug: true, createdAt: true },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    db.organization.count(),
  ]);
}
