import { getDb } from '../../lib/db.js';

export function listOrgs() {
  return getDb().organization.findMany({ orderBy: [{ name: 'asc' }, { id: 'asc' }], select: { id: true, name: true, slug: true, createdAt: true } });
}
