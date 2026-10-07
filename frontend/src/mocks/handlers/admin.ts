import { currentUser, fail, json, mock, notFound, paginate, param, readBody, readQuery, route } from '../core';
import { markRefundDone } from '../domain';
import { toRefund } from '../serializers';
import { DEFAULT_SETTINGS } from '../state';

function requirePlatformAdmin(request: Request) {
  const user = currentUser(request);
  // Non-admin : 404 (on ne révèle pas l'existence de l'espace d'administration).
  if (!user.isPlatformAdmin) notFound();
  return user;
}

export const adminHandlers = [
  route('get', '/admin/orgs', ({ request, url }) => {
    requirePlatformAdmin(request);
    const q = readQuery(url, []);
    const sorted = [...mock.db.orgs].sort((a, b) => a.name.localeCompare(b.name, 'fr')).map((o) => ({ ...o }));
    return json(paginate(sorted, q.page, q.pageSize)); // contrat v1.8 : paginé, tri par nom
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

  // ---------------- Anomalies (contrat v1.17 §8) ----------------
  route('get', '/admin/refunds', ({ request, url }) => {
    requirePlatformAdmin(request);
    const q = readQuery(url, ['status']);
    const items = mock.db.refunds
      .filter((r) => r.orderId === null && (!q.get('status') || r.status === q.get('status')))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(toRefund);
    return json(paginate(items, q.page, q.pageSize));
  }),

  route('post', '/admin/refunds/:refundId/mark-done', async ({ request, params }) => {
    requirePlatformAdmin(request);
    const r = mock.db.refunds.find((x) => x.id === param(params, 'refundId') && x.orderId === null) ?? notFound();
    const v = await readBody(request, ['note']);
    const note = v.str('note', { min: 1, max: 500 });
    v.done();
    markRefundDone(r, note ?? '');
    return json(toRefund(r));
  }),

  route('get', '/admin/stuck-orders', ({ request, url }) => {
    requirePlatformAdmin(request);
    const q = readQuery(url, []);
    const items = mock.db.orders
      .filter((o) => (o.expireFailures ?? 0) >= 5 && (o.status === 'PENDING_PAYMENT' || o.status === 'AWAITING_TRANSFER'))
      .sort((a, b) => (a.expiresAt ?? '').localeCompare(b.expiresAt ?? ''))
      .map(toStuckOrder);
    return json(paginate(items, q.page, q.pageSize));
  }),

  route('post', '/admin/stuck-orders/:orderId/retry', ({ request, params }) => {
    requirePlatformAdmin(request);
    const o = mock.db.orders.find((x) => x.id === param(params, 'orderId') && (x.expireFailures ?? 0) >= 5) ?? notFound();
    o.expireFailures = 0; // reprise au prochain passage du worker
    return json(toStuckOrder(o));
  }),
];

function toStuckOrder(o: (typeof mock.db.orders)[number]) {
  const e = mock.db.events.find((x) => x.id === o.eventId);
  return {
    id: o.id,
    orgId: e?.orgId ?? '',
    eventId: o.eventId,
    eventTitle: e?.title ?? '',
    buyerEmail: mock.db.users.find((u) => u.id === o.userId)?.email ?? '',
    status: o.status,
    paymentMethod: o.paymentMethod,
    totalCents: o.totalCents,
    expiresAt: o.expiresAt ?? o.createdAt,
    expireFailures: o.expireFailures ?? 0,
    createdAt: o.createdAt,
  };
}
