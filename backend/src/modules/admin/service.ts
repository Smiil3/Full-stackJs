import { writeAudit } from '../../lib/audit.js';
import { transaction } from '../../lib/db.js';
import { normalizeEmail } from '../../lib/email.js';
import { errors } from '../../lib/errors.js';
import { iso } from '../../lib/schemas.js';
import * as repo from './repo.js';
import type { CreateOrgBody } from './schemas.js';

export async function listOrgs() {
  return { items: (await repo.listOrgs()).map((o) => ({ id: o.id, name: o.name, slug: o.slug, createdAt: iso(o.createdAt) })) };
}

/** Création d'un collectif par l'admin plateforme : propriétaire = compte existant ET vérifié. */
export async function createOrg(actorId: string, body: CreateOrgBody) {
  const ownerEmail = normalizeEmail(body.ownerEmail);
  const org = await transaction(async (tx) => {
    const owner = await tx.user.findUnique({ where: { email: ownerEmail }, select: { id: true, emailVerifiedAt: true } });
    if (!owner?.emailVerifiedAt) throw errors.notFound();
    if (await tx.organization.findUnique({ where: { slug: body.slug }, select: { id: true } })) {
      throw errors.conflict('Ce slug est déjà utilisé.');
    }
    const created = await tx.organization.create({ data: { name: body.name.trim(), slug: body.slug } });
    await tx.organizationSettings.create({ data: { orgId: created.id } });
    await tx.membership.create({ data: { orgId: created.id, userId: owner.id, role: 'OWNER' } });
    await writeAudit(tx, { orgId: created.id, actorId, action: 'org.create', target: `org:${created.id}`, meta: { slug: created.slug, ownerId: owner.id } });
    return created;
  });
  return { id: org.id, name: org.name, slug: org.slug, createdAt: iso(org.createdAt) };
}
