import { beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../../src/lib/db.js';
import { PASSWORD, api, createUser, loggedInUser } from '../helpers.js';
import { createEvent, orgWithStaff, type OrgFixture } from '../fixtures.js';

const VALID_IBAN = 'FR76 3000 6000 0112 3456 7890 189';
let a: OrgFixture;
let b: OrgFixture;

beforeEach(async () => {
  a = await orgWithStaff('collectif-a');
  b = await orgWithStaff('collectif-b');
});

describe('isolation entre collectifs (IDOR)', () => {
  it('un MANAGER du collectif A ne voit rien du collectif B (404)', async () => {
    const { eventId, ticketTypeIds } = await createEvent(b, { ticketTypes: [{ name: 'Fosse', capacity: 10, priceCents: 1000 }] });
    const auth = a.manager.auth;
    const base = `/api/v1/orgs/${b.id}`;
    for (const path of ['', '/settings', '/members', '/events', `/events/${eventId}`]) {
      const res = await api().get(base + path).set(auth);
      expect(res.status, path).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    }
    await api().patch(`${base}/settings`).set(a.owner.auth).send({ refundPercent: 0 }).expect(404);
    await api().patch(`${base}/events/${eventId}`).set(auth).send({ title: 'Piraté' }).expect(404);
    await api().post(`${base}/events/${eventId}/publish`).set(auth).expect(404);
    await api().post(`${base}/members`).set(a.owner.auth).send({ email: a.manager.email, role: 'OWNER' }).expect(404);
    // Ressource de B adressée via le préfixe de A : 404 également.
    await api().get(`/api/v1/orgs/${a.id}/events/${eventId}`).set(auth).expect(404);
    await api().patch(`/api/v1/orgs/${a.id}/events/${eventId}`).set(auth).send({ title: 'Piraté' }).expect(404);
    await api().post(`/api/v1/orgs/${a.id}/events/${eventId}/ticket-types`).set(auth).send({ name: 'X', capacity: 1, priceCents: 0 }).expect(404);
    await api().patch(`/api/v1/orgs/${a.id}/events/${eventId}/ticket-types/${ticketTypeIds[0]!}`).set(auth).send({ capacity: 999 }).expect(404);
    await api().delete(`/api/v1/orgs/${a.id}/events/${eventId}/ticket-types/${ticketTypeIds[0]!}`).set(auth).expect(404);
    const untouched = await getDb().event.findUniqueOrThrow({ where: { id: eventId } });
    expect(untouched.title).toBe('Nuit test');
  });

  it('type de place d’un autre événement via un événement autorisé ⇒ 404', async () => {
    const own = await createEvent(a);
    const foreign = await createEvent(b, { ticketTypes: [{ name: 'Fosse', capacity: 10, priceCents: 1000 }] });
    await api().patch(`/api/v1/orgs/${a.id}/events/${own.eventId}/ticket-types/${foreign.ticketTypeIds[0]!}`)
      .set(a.manager.auth).send({ capacity: 999 }).expect(404);
  });

  it('identifiant de collectif mal formé ou inexistant ⇒ 404', async () => {
    await api().get('/api/v1/orgs/pas-un-uuid').set(a.owner.auth).expect(404);
    await api().get('/api/v1/orgs/11111111-1111-4111-8111-111111111111').set(a.owner.auth).expect(404);
  });

  it('sans authentification ⇒ 401', async () => {
    await api().get(`/api/v1/orgs/${a.id}`).expect(401);
  });
});

describe('rôles', () => {
  it('SCANNER : collectif et événements à contrôler (sans chiffres), pas les ventes, réglages ni membres (403)', async () => {
    await api().get(`/api/v1/orgs/${a.id}`).set(a.scanner.auth).expect(200);
    const { eventId } = await createEvent(a, { ticketTypes: [{ name: 'T', capacity: 10, priceCents: 1000 }], publish: true });
    await api().get(`/api/v1/orgs/${a.id}/events`).set(a.scanner.auth).expect(403);
    await api().get(`/api/v1/orgs/${a.id}/events/${eventId}`).set(a.scanner.auth).expect(403);
    const checkin = await api().get(`/api/v1/orgs/${a.id}/checkin/events`).set(a.scanner.auth).expect(200);
    expect(checkin.body.items).toHaveLength(1);
    expect(Object.keys(checkin.body.items[0] as object).sort()).toEqual(['endsAt', 'id', 'isOnline', 'offlineCheckinEnabled', 'startsAt', 'status', 'timezone', 'title', 'venue']);
    const res = await api().get(`/api/v1/orgs/${a.id}/settings`).set(a.scanner.auth);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    await api().get(`/api/v1/orgs/${a.id}/members`).set(a.scanner.auth).expect(403);
    await api().post(`/api/v1/orgs/${a.id}/events`).set(a.scanner.auth).send({}).expect(403);
  });

  it('MANAGER : lit les réglages mais ne peut pas les modifier ni gérer les membres', async () => {
    await api().get(`/api/v1/orgs/${a.id}/settings`).set(a.manager.auth).expect(200);
    await api().patch(`/api/v1/orgs/${a.id}/settings`).set(a.manager.auth).send({ refundPercent: 0 }).expect(403);
    await api().post(`/api/v1/orgs/${a.id}/members`).set(a.manager.auth).send({ email: a.scanner.email, role: 'OWNER' }).expect(403);
    await api().get(`/api/v1/orgs/${a.id}/audit-log`).set(a.manager.auth).expect(403);
    const settings = await getDb().organizationSettings.findUniqueOrThrow({ where: { orgId: a.id } });
    expect(settings.refundPercent).toBe(100);
  });

  it('le rôle est relu en base à chaque requête (rétrogradation immédiate)', async () => {
    await api().get(`/api/v1/orgs/${a.id}/settings`).set(a.manager.auth).expect(200);
    await getDb().membership.update({ where: { userId_orgId: { userId: a.manager.id, orgId: a.id } }, data: { role: 'SCANNER' } });
    await api().get(`/api/v1/orgs/${a.id}/settings`).set(a.manager.auth).expect(403);
    await getDb().membership.delete({ where: { userId_orgId: { userId: a.manager.id, orgId: a.id } } });
    await api().get(`/api/v1/orgs/${a.id}`).set(a.manager.auth).expect(404);
  });
});

describe('réglages du collectif', () => {
  it('valeurs par défaut du plan', async () => {
    const res = await api().get(`/api/v1/orgs/${a.id}/settings`).set(a.owner.auth).expect(200);
    expect(res.body).toMatchObject({
      cardHoldMinutes: 15, transferHoldHours: 72, transferEnabled: true, cancellationDeadlineHours: 48,
      selfCancellationEnabled: true, refundPercent: 100, serviceFeeRefundable: false, maxPerOrder: 6, maxPerUser: 6,
      waitlistOfferMinutes: 120, waitlistEnabled: true, serviceFeeFixedCents: 0, serviceFeeBasisPoints: 0,
      defaultTimezone: 'Europe/Paris', contactEmail: null, bank: { beneficiary: null, ibanMasked: null, bic: null },
    });
  });

  it('bornes Joi et contrôle croisé maxPerUser ≥ maxPerOrder', async () => {
    const patch = (body: Record<string, unknown>) => api().patch(`/api/v1/orgs/${a.id}/settings`).set(a.owner.auth).send(body);
    for (const body of [
      { cardHoldMinutes: 4 }, { cardHoldMinutes: 61 }, { transferHoldHours: 241 }, { refundPercent: 101 },
      { maxPerOrder: 21 }, { maxPerUser: 51 }, { waitlistOfferMinutes: 14 }, { serviceFeeBasisPoints: 1501 },
      { serviceFeeFixedCents: 1001 }, { cancellationDeadlineHours: -1 }, { defaultTimezone: 'Mars/Olympus' },
      { maxPerUser: 4 }, { isAdmin: true }, {},
    ]) {
      const res = await patch(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    await patch({ maxPerOrder: 10, maxPerUser: 12, serviceFeeBasisPoints: 250, contactEmail: 'Contact@Collectif.fr' }).expect(200);
    const s = await getDb().organizationSettings.findUniqueOrThrow({ where: { orgId: a.id } });
    expect(s).toMatchObject({ maxPerOrder: 10, maxPerUser: 12, serviceFeeBasisPoints: 250, contactEmail: 'contact@collectif.fr' });
  });

  it('IBAN invalide refusé ; IBAN valide stocké chiffré et jamais renvoyé en clair', async () => {
    const bad = await api().patch(`/api/v1/orgs/${a.id}/settings`).set(a.owner.auth)
      .send({ bank: { beneficiary: 'Collectif A', iban: 'FR76 3000 6000 0112 3456 7890 188', bic: 'AGRIFRPP' }, currentPassword: PASSWORD });
    expect(bad.status).toBe(400);
    await api().patch(`/api/v1/orgs/${a.id}/settings`).set(a.owner.auth)
      .send({ bank: { beneficiary: 'Collectif A', iban: VALID_IBAN } }).expect(400);
    const ok = await api().patch(`/api/v1/orgs/${a.id}/settings`).set(a.owner.auth)
      .send({ bank: { beneficiary: 'Collectif A', iban: VALID_IBAN, bic: 'AGRIFRPP' }, currentPassword: PASSWORD }).expect(200);
    expect(ok.body.bank).toEqual({ beneficiary: 'Collectif A', ibanMasked: 'FR76 •••• •••• 0189', bic: 'AGRIFRPP' });
    const plain = VALID_IBAN.replace(/\s/g, '');
    const responses = [
      ok,
      await api().get(`/api/v1/orgs/${a.id}/settings`).set(a.manager.auth),
      await api().get(`/api/v1/orgs/${a.id}/audit-log`).set(a.owner.auth),
    ];
    for (const r of responses) expect(JSON.stringify(r.body)).not.toContain(plain.slice(4, 20));
    const row = await getDb().organizationSettings.findUniqueOrThrow({ where: { orgId: a.id } });
    expect(row.bankIbanEncrypted).not.toContain(plain);
    expect(row.bankIbanEncrypted!.startsWith('v1.')).toBe(true);
    const audits = await getDb().auditLog.findMany({ where: { orgId: a.id, action: 'settings.update' } });
    expect(JSON.stringify(audits)).not.toContain(plain.slice(4, 20));
    expect(JSON.stringify(audits)).toContain('FR76 •••• •••• 0189');
  });

  it('toute modification est tracée (avant / après)', async () => {
    await api().patch(`/api/v1/orgs/${a.id}/settings`).set(a.owner.auth).send({ refundPercent: 50 }).expect(200);
    const log = await api().get(`/api/v1/orgs/${a.id}/audit-log`).set(a.owner.auth).expect(200);
    const entry = (log.body.items as { action: string; actorEmail: string; meta: { changes: Record<string, unknown> } }[])
      .find((e) => e.action === 'settings.update');
    expect(entry?.actorEmail).toBe(a.owner.email);
    expect(entry?.meta.changes['refundPercent']).toEqual({ from: 100, to: 50 });
  });
});

describe('membres', () => {
  it('ajout d’un compte vérifié ; compte inconnu ou non vérifié ⇒ 404 ; doublon ⇒ 409', async () => {
    const newcomer = await createUser({ email: 'nouveau-membre@test.fr' });
    const res = await api().post(`/api/v1/orgs/${a.id}/members`).set(a.owner.auth).send({ email: 'Nouveau-Membre@test.fr', role: 'SCANNER' }).expect(201);
    expect(res.body).toEqual({ userId: newcomer.id, email: newcomer.email, displayName: 'Jean Test', role: 'SCANNER', createdAt: expect.any(String) });
    await createUser({ email: 'pas-verifie@test.fr', verified: false });
    await api().post(`/api/v1/orgs/${a.id}/members`).set(a.owner.auth).send({ email: 'pas-verifie@test.fr', role: 'SCANNER' }).expect(404);
    await api().post(`/api/v1/orgs/${a.id}/members`).set(a.owner.auth).send({ email: 'inconnu@test.fr', role: 'SCANNER' }).expect(404);
    const dup = await api().post(`/api/v1/orgs/${a.id}/members`).set(a.owner.auth).send({ email: newcomer.email, role: 'MANAGER' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('CONFLICT');
  });

  it('le dernier OWNER ne peut être ni rétrogradé ni retiré', async () => {
    const demote = await api().patch(`/api/v1/orgs/${a.id}/members/${a.owner.id}`).set(a.owner.auth).send({ role: 'MANAGER' });
    expect(demote.status).toBe(409);
    await api().delete(`/api/v1/orgs/${a.id}/members/${a.owner.id}`).set(a.owner.auth).expect(409);
    // Avec un second OWNER, c'est possible.
    await api().patch(`/api/v1/orgs/${a.id}/members/${a.manager.id}`).set(a.owner.auth).send({ role: 'OWNER' }).expect(200);
    await api().delete(`/api/v1/orgs/${a.id}/members/${a.owner.id}`).set(a.owner.auth).expect(204);
  });

  it('deux OWNER qui se rétrogradent mutuellement en même temps : il en reste toujours un', async () => {
    const second = await loggedInUser();
    await getDb().membership.create({ data: { orgId: a.id, userId: second.id, role: 'OWNER' } });
    const results = await Promise.all([
      api().patch(`/api/v1/orgs/${a.id}/members/${second.id}`).set(a.owner.auth).send({ role: 'MANAGER' }),
      api().patch(`/api/v1/orgs/${a.id}/members/${a.owner.id}`).set(second.auth).send({ role: 'MANAGER' }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await getDb().membership.count({ where: { orgId: a.id, role: 'OWNER' } })).toBe(1);
  });

  it('membre d’un autre collectif ⇒ 404', async () => {
    await api().patch(`/api/v1/orgs/${a.id}/members/${b.manager.id}`).set(a.owner.auth).send({ role: 'SCANNER' }).expect(404);
    await api().delete(`/api/v1/orgs/${a.id}/members/${b.manager.id}`).set(a.owner.auth).expect(404);
  });

  it('liste des membres (MANAGER+) sans donnée sensible', async () => {
    const res = await api().get(`/api/v1/orgs/${a.id}/members`).set(a.manager.auth).expect(200);
    expect(res.body.items).toHaveLength(3);
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|tokenVersion|failedLoginCount/);
  });
});

describe('administration plateforme', () => {
  it('non-admin ⇒ 404 ; admin crée un collectif avec un propriétaire vérifié', async () => {
    await api().get('/api/v1/admin/orgs').set(a.owner.auth).expect(404);
    const admin = await loggedInUser({ admin: true });
    const owner = await createUser({ email: 'proprio@test.fr' });
    const res = await api().post('/api/v1/admin/orgs').set(admin.auth).send({ name: 'Nouveau collectif', slug: 'nouveau', ownerEmail: owner.email }).expect(201);
    expect(res.body).toEqual({ id: expect.any(String), name: 'Nouveau collectif', slug: 'nouveau', createdAt: expect.any(String) });
    const membership = await getDb().membership.findFirstOrThrow({ where: { orgId: res.body.id as string } });
    expect(membership).toMatchObject({ userId: owner.id, role: 'OWNER' });
    expect(await getDb().organizationSettings.count({ where: { orgId: res.body.id as string } })).toBe(1);
    await api().post('/api/v1/admin/orgs').set(admin.auth).send({ name: 'Doublon', slug: 'nouveau', ownerEmail: owner.email }).expect(409);
    await api().post('/api/v1/admin/orgs').set(admin.auth).send({ name: 'Collectif X', slug: 'autre', ownerEmail: 'inconnu@test.fr' }).expect(404);
    await api().post('/api/v1/admin/orgs').set(admin.auth).send({ name: 'Collectif X', slug: 'Pas Valide', ownerEmail: owner.email }).expect(400);
    const list = await api().get('/api/v1/admin/orgs').set(admin.auth).expect(200);
    expect((list.body.items as unknown[]).length).toBe(3);
  });
});
