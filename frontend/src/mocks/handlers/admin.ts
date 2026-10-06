import { currentUser, fail, json, mock, notFound, readBody, route } from '../core';
import { DEFAULT_SETTINGS } from '../state';

function requirePlatformAdmin(request: Request) {
  const user = currentUser(request);
  // Non-admin : 404 (on ne révèle pas l'existence de l'espace d'administration).
  if (!user.isPlatformAdmin) notFound();
  return user;
}

export const adminHandlers = [
  route('get', '/admin/orgs', ({ request }) => {
    requirePlatformAdmin(request);
    return json({ items: mock.db.orgs.map((o) => ({ ...o })) });
  }),

  route('post', '/admin/orgs', async ({ request }) => {
    requirePlatformAdmin(request);
    const v = await readBody(request, ['name', 'slug', 'ownerEmail']);
    const name = v.str('name', { min: 2, max: 80 });
    const slug = v.str('slug', { pattern: /^[a-z0-9-]{2,40}$/ });
    const ownerEmail = v.email('ownerEmail');
    v.done();
    const owner = mock.db.users.find((u) => u.email === ownerEmail?.trim().toLowerCase() && u.emailVerified);
    if (!owner) return notFound();
    if (mock.db.orgs.some((o) => o.slug === slug)) fail(409, 'CONFLICT', 'Slug déjà pris');
    const org = { id: crypto.randomUUID(), name: name?.trim() ?? '', slug: slug ?? '', createdAt: new Date().toISOString() };
    mock.db.orgs.push(org);
    mock.db.memberships.push({ userId: owner.id, orgId: org.id, role: 'OWNER', createdAt: org.createdAt });
    mock.db.settings.set(org.id, { ...DEFAULT_SETTINGS, contactEmail: null, bank: { beneficiary: null, iban: null, bic: null } });
    return json(org, 201);
  }),
];
