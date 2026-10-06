import { randomUUID } from 'node:crypto';
import express from 'express';
import supertest from 'supertest';
import Joi from 'joi';
import { pinoHttp } from 'pino-http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Prisma } from '../../src/generated/prisma/client.js';
import { getDb } from '../../src/lib/db.js';
import { getLogger } from '../../src/lib/logger.js';
import { testClock } from '../../src/lib/clock.js';
import { decryptOutboxPayload } from '../../src/lib/outbox.js';
import { endpoint } from '../../src/middlewares/validate.js';
import { errorHandler } from '../../src/middlewares/errorHandler.js';
import { PASSWORD, api, createUser, lastMail, loggedInUser, type LoggedIn } from '../helpers.js';
import { createEvent, eventBody, orgWithStaff, type OrgFixture } from '../fixtures.js';

let a: OrgFixture;
let b: OrgFixture;
let buyer: LoggedIn;
const IBAN_A = 'FR7630006000011234567890189';
const IBAN_B = 'DE89370400440532013000';

beforeEach(async () => {
  a = await orgWithStaff('b31-a');
  b = await orgWithStaff('b31-b');
  buyer = await loggedInUser({ email: 'acheteur-b31@test.fr' });
});
afterEach(() => {
  testClock.reset();
});

const ev = (org: OrgFixture, path = '') => `/api/v1/orgs/${org.id}/events${path}`;
const buy = (eventId: string, ticketTypeId: string, quantity = 1, paymentMethod = 'CARD') =>
  api().post('/api/v1/orders').set(buyer.auth).set('Idempotency-Key', randomUUID()).send({ eventId, paymentMethod, items: [{ ticketTypeId, quantity }] });

describe('report d’un événement (B3.1 H1)', () => {
  it('avec des commandes : OWNER seulement, motif obligatoire, droits au remboursement intégral, mails, audit', async () => {
    const { eventId, ticketTypeIds } = await createEvent(a, { ticketTypes: [{ name: 'Fosse', capacity: 50, priceCents: 2000 }], publish: true });
    const order = await buy(eventId, ticketTypeIds[0]!, 2).expect(201);
    // Commande payée (simulation du paiement, couvert en B5).
    const before = await getDb().order.update({
      where: { id: order.body.id as string },
      data: { status: 'PAID', paidAt: new Date(), refundPercent: 50 },
    });
    const ev0 = await getDb().event.findUniqueOrThrow({ where: { id: eventId } });
    const newStart = new Date(ev0.startsAt.getTime() + 7 * 86400_000);
    const newEnd = new Date(ev0.endsAt.getTime() + 7 * 86400_000);
    const patch = { startsAt: newStart.toISOString(), endsAt: newEnd.toISOString(), salesEndAt: newStart.toISOString() };

    const asManager = await api().patch(ev(a, `/${eventId}`)).set(a.manager.auth).send(patch);
    expect(asManager.status).toBe(403);
    const noReason = await api().patch(ev(a, `/${eventId}`)).set(a.owner.auth).send(patch);
    expect(noReason.status).toBe(400);
    expect(noReason.body.error.details.fields[0].path).toBe('rescheduleReason');
    await api().patch(ev(a, `/${eventId}`)).set(a.owner.auth).send({ ...patch, rescheduleReason: 'Salle indisponible' }).expect(200);

    const after = await getDb().order.findUniqueOrThrow({ where: { id: before.id } });
    expect(after.refundPercent).toBe(100);
    expect(after.serviceFeeRefundable).toBe(true);
    const deadline = ev0.startsAt.getTime() - before.cancellableUntil!.getTime();
    expect(after.cancellableUntil!.getTime()).toBe(newStart.getTime() - deadline);
    const mail = await lastMail(buyer.email, 'eventRescheduled');
    expect(decryptOutboxPayload(mail!)['reason']).toBe('Salle indisponible');
    const audit = await getDb().auditLog.findFirstOrThrow({ where: { orgId: a.id, action: 'event.reschedule' } });
    expect(audit.meta).toMatchObject({ reason: 'Salle indisponible', paidOrders: 1, notifiedBuyers: 1 });
    // L'aperçu de remboursement de l'acheteur reflète le nouveau droit (100 %).
    const view = await api().get(`/api/v1/orders/${before.id}`).set(buyer.auth).expect(200);
    expect(view.body.refundPreviewCents).toBe(4000);
  });

  it('sans aucune commande, un MANAGER peut déplacer les dates', async () => {
    const { eventId } = await createEvent(a, { ticketTypes: [{ name: 'T', capacity: 10, priceCents: 1000 }], publish: true });
    const ev0 = await getDb().event.findUniqueOrThrow({ where: { id: eventId } });
    await api().patch(ev(a, `/${eventId}`)).set(a.manager.auth)
      .send({ startsAt: new Date(ev0.startsAt.getTime() + 3600_000).toISOString(), endsAt: new Date(ev0.endsAt.getTime() + 3600_000).toISOString() })
      .expect(200);
  });

  it('prix modifié après ventes : commandes existantes inchangées, nouvelles au nouveau prix, audit avant / après', async () => {
    const { eventId, ticketTypeIds } = await createEvent(a, { ticketTypes: [{ name: 'Fosse', capacity: 50, priceCents: 2000 }], publish: true });
    const first = await buy(eventId, ticketTypeIds[0]!).expect(201);
    await api().patch(ev(a, `/${eventId}/ticket-types/${ticketTypeIds[0]!}`)).set(a.manager.auth).send({ priceCents: 2500 }).expect(200);
    const again = await api().get(`/api/v1/orders/${first.body.id as string}`).set(buyer.auth).expect(200);
    expect(again.body.items[0].unitPriceCents).toBe(2000);
    const second = await buy(eventId, ticketTypeIds[0]!).expect(201);
    expect(second.body.items[0].unitPriceCents).toBe(2500);
    const audit = await getDb().auditLog.findFirstOrThrow({ where: { orgId: a.id, action: 'ticketType.update' } });
    expect(audit.meta).toMatchObject({ changes: { priceCents: { from: 2000, to: 2500 } }, soldAtChange: 0 });
  });
});

describe('invariants de dates (B3.1 M1 / M2)', () => {
  it('PATCH partiel : invariants vérifiés sur les valeurs fusionnées', async () => {
    const { eventId } = await createEvent(a);
    const ev0 = await getDb().event.findUniqueOrThrow({ where: { id: eventId } });
    // Fin avancée avant la fin des ventes existante.
    const res = await api().patch(ev(a, `/${eventId}`)).set(a.manager.auth).send({ endsAt: new Date(ev0.salesEndAt.getTime() - 1000).toISOString() });
    expect(res.status).toBe(400);
    await api().patch(ev(a, `/${eventId}`)).set(a.manager.auth).send({ salesStartAt: ev0.salesEndAt.toISOString() }).expect(400);
  });

  it('publication refusée si la période de vente est terminée', async () => {
    const { eventId } = await createEvent(a, { ticketTypes: [{ name: 'T', capacity: 10, priceCents: 1000 }] });
    const ev0 = await getDb().event.findUniqueOrThrow({ where: { id: eventId } });
    testClock.freeze(new Date(ev0.salesEndAt.getTime() + 1));
    const res = await api().post(ev(a, `/${eventId}/publish`)).set(a.manager.auth);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
  });

  it('détail public : 404 pour un événement terminé depuis plus de 30 jours', async () => {
    const { eventId } = await createEvent(a, { ticketTypes: [{ name: 'T', capacity: 10, priceCents: 1000 }], publish: true });
    const ev0 = await getDb().event.findUniqueOrThrow({ where: { id: eventId } });
    testClock.freeze(new Date(ev0.endsAt.getTime() + 29 * 86400_000));
    await api().get(`/api/v1/events/${eventId}`).expect(200);
    testClock.freeze(new Date(ev0.endsAt.getTime() + 31 * 86400_000));
    await api().get(`/api/v1/events/${eventId}`).expect(404);
  });

  it('earlyUntil ≤ salesEndAt, revalidé quand les dates de l’événement changent (409 explicite)', async () => {
    const { eventId } = await createEvent(a);
    const ev0 = await getDb().event.findUniqueOrThrow({ where: { id: eventId } });
    const url = ev(a, `/${eventId}/ticket-types`);
    await api().post(url).set(a.manager.auth)
      .send({ name: 'E', capacity: 10, priceCents: 2000, earlyPriceCents: 1500, earlyUntil: new Date(ev0.salesEndAt.getTime() + 1000).toISOString() })
      .expect(400);
    const early = new Date(ev0.salesEndAt.getTime() - 86400_000);
    const tt = await api().post(url).set(a.manager.auth).send({ name: 'E', capacity: 10, priceCents: 2000, earlyPriceCents: 1500, earlyUntil: early.toISOString() }).expect(201);
    const res = await api().patch(ev(a, `/${eventId}`)).set(a.manager.auth).send({ salesEndAt: new Date(early.getTime() - 1000).toISOString() });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: 'CONFLICT', details: { ticketTypeIds: [tt.body.id] } });
    // PATCH partiel du prix contre la valeur early existante.
    await api().patch(ev(a, `/${eventId}/ticket-types/${tt.body.id as string}`)).set(a.manager.auth).send({ priceCents: 1500 }).expect(400);
    await api().patch(ev(a, `/${eventId}/ticket-types/${tt.body.id as string}`)).set(a.manager.auth).send({ earlyPriceCents: 1999 }).expect(200);
  });
});

describe('suppression de type et réservation concurrentes (B3.1 M3)', () => {
  it('jamais de 500 ni d’état incohérent', async () => {
    for (let i = 0; i < 5; i += 1) {
      const { eventId, ticketTypeIds } = await createEvent(a, {
        ticketTypes: [{ name: 'A', capacity: 10, priceCents: 1000 }, { name: 'B', capacity: 10, priceCents: 1000 }], publish: true,
      });
      const [del, ord] = await Promise.all([
        api().delete(ev(a, `/${eventId}/ticket-types/${ticketTypeIds[0]!}`)).set(a.manager.auth),
        buy(eventId, ticketTypeIds[0]!),
      ]);
      expect([del.status, ord.status]).not.toContain(500);
      if (del.status === 204) {
        expect([404, 409]).toContain(ord.status);
        expect(await getDb().orderItem.count({ where: { ticketTypeId: ticketTypeIds[0]! } })).toBe(0);
      } else {
        expect(del.status).toBe(409);
        expect(ord.status).toBe(201);
      }
    }
  });

  it('violation de clé étrangère (P2003) ⇒ 409 CONFLICT, jamais 500', async () => {
    const app = express();
    app.use(pinoHttp({ logger: getLogger() }));
    app.post('/fk', ...endpoint({ response: Joi.object({}) }, () =>
      Promise.reject(new Prisma.PrismaClientKnownRequestError('fk', { code: 'P2003', clientVersion: 'test' }))));
    app.use(errorHandler);
    const res = await supertest(app).post('/fk').expect(409);
    expect(res.body.error.code).toBe('CONFLICT');
  });
});

describe('changement de coordonnées bancaires (B3.1 M4)', () => {
  const bankPatch = (iban: string, currentPassword?: string) => ({
    bank: { beneficiary: 'Collectif A', iban, bic: 'AGRIFRPP' }, ...(currentPassword === undefined ? {} : { currentPassword }),
  });

  it('ré-authentification obligatoire, comptée dans le verrouillage', async () => {
    const url = `/api/v1/orgs/${a.id}/settings`;
    await api().patch(url).set(a.owner.auth).send(bankPatch(IBAN_A)).expect(400);
    const wrong = await api().patch(url).set(a.owner.auth).send(bankPatch(IBAN_A, 'mauvais-mot-de-passe'));
    expect(wrong.status).toBe(401);
    expect(wrong.body.error.code).toBe('INVALID_CREDENTIALS');
    const owner = await getDb().user.findUniqueOrThrow({ where: { id: a.owner.id } });
    expect(owner.failedLoginCount).toBe(1);
    expect((await getDb().organizationSettings.findUniqueOrThrow({ where: { orgId: a.id } })).bankIbanEncrypted).toBeNull();
    // currentPassword sans changement bancaire : refusé.
    await api().patch(url).set(a.owner.auth).send({ refundPercent: 10, currentPassword: PASSWORD }).expect(400);
    await api().patch(url).set(a.owner.auth).send(bankPatch(IBAN_A, PASSWORD)).expect(200);
  });

  it('tous les OWNER sont prévenus ; une commande en attente de virement garde ses coordonnées', async () => {
    const second = await createUser({ email: 'second-owner@test.fr' });
    await getDb().membership.create({ data: { orgId: a.id, userId: second.id, role: 'OWNER' } });
    const url = `/api/v1/orgs/${a.id}/settings`;
    await api().patch(url).set(a.owner.auth).send(bankPatch(IBAN_A, PASSWORD)).expect(200);
    const { eventId, ticketTypeIds } = await createEvent(a, { ticketTypes: [{ name: 'T', capacity: 10, priceCents: 1000 }], publish: true });
    const order = await buy(eventId, ticketTypeIds[0]!, 1, 'TRANSFER').expect(201);
    expect(order.body.transferInstructions.iban).toBe(IBAN_A);
    await getDb().emailToken.deleteMany();
    await api().patch(url).set(a.owner.auth).send(bankPatch(IBAN_B, PASSWORD)).expect(200);
    for (const email of [a.owner.email, second.email]) {
      const mail = await lastMail(email, 'bankDetailsChanged');
      expect(decryptOutboxPayload(mail!)['ibanMasked']).toBe('DE89 •••• •••• 3000');
    }
    const view = await api().get(`/api/v1/orders/${order.body.id as string}`).set(buyer.auth).expect(200);
    expect(view.body.transferInstructions.iban).toBe(IBAN_A);
  });
});

describe('ajout de membre (B3.1 M5)', () => {
  it('la personne ajoutée reçoit un mail (collectif, rôle, ajouté par)', async () => {
    const newcomer = await createUser({ email: 'arrivee@test.fr' });
    await api().post(`/api/v1/orgs/${a.id}/members`).set(a.owner.auth).send({ email: newcomer.email, role: 'MANAGER' }).expect(201);
    const payload = decryptOutboxPayload((await lastMail(newcomer.email, 'memberAdded'))!);
    expect(payload).toMatchObject({ orgName: 'Collectif b31-a', role: 'MANAGER', addedBy: 'Jean Test' });
  });
});

describe('validations et audit (B3.1 M6 / B1 / B3 / B4)', () => {
  it('page ≤ 1000 partout ; from ≤ to', async () => {
    await api().get('/api/v1/events?page=1001').expect(400);
    await api().get('/api/v1/events?page=1000').expect(200);
    await api().get(`/api/v1/orgs/${a.id}/audit-log?page=1001`).set(a.owner.auth).expect(400);
    const res = await api().get(`/api/v1/events?from=${encodeURIComponent('2030-02-01T00:00:00Z')}&to=${encodeURIComponent('2030-01-01T00:00:00Z')}`);
    expect(res.status).toBe(400);
  });

  it('textes : espaces retirés avant les règles de longueur', async () => {
    await api().post(ev(a)).set(a.manager.auth).send(eventBody({ title: '   ' })).expect(400);
    const ok = await api().post(ev(a)).set(a.manager.auth).send(eventBody({ title: '  Nuit d’automne  ', venue: '   ' }));
    expect(ok.status).toBe(400);
    const created = await api().post(ev(a)).set(a.manager.auth).send(eventBody({ title: '  Nuit d’automne  ' })).expect(201);
    expect(created.body.title).toBe('Nuit d’automne');
  });

  it('PATCH { overrides: {} } ⇒ 400 (aucune entrée d’audit vide)', async () => {
    const { eventId } = await createEvent(a);
    await api().patch(ev(a, `/${eventId}`)).set(a.manager.auth).send({ overrides: {} }).expect(400);
    expect(await getDb().auditLog.count({ where: { action: 'event.update' } })).toBe(0);
  });

  it('audit : libellé « Administrateur plateforme » pour un admin non membre, null pour le système', async () => {
    const admin = await loggedInUser({ admin: true });
    const owner = await createUser({ email: 'proprio-audit@test.fr' });
    const created = await api().post('/api/v1/admin/orgs').set(admin.auth).send({ name: 'Collectif audit', slug: 'audit', ownerEmail: owner.email }).expect(201);
    await getDb().auditLog.create({ data: { orgId: created.body.id as string, actorId: null, action: 'system.test', target: 'x', meta: {} } });
    const ownerSession = await (await import('../helpers.js')).login(owner);
    const log = await api().get(`/api/v1/orgs/${created.body.id as string}/audit-log`).set(ownerSession.auth).expect(200);
    const byAction = Object.fromEntries((log.body.items as { action: string; actorEmail: string | null }[]).map((e) => [e.action, e.actorEmail]));
    expect(byAction['org.create']).toBe('Administrateur plateforme');
    expect(byAction['system.test']).toBeNull();
    expect(JSON.stringify(log.body)).not.toContain(admin.email);
  });

  it('GET /admin/orgs paginé, tri nom puis id', async () => {
    const admin = await loggedInUser({ admin: true });
    const res = await api().get('/api/v1/admin/orgs?pageSize=1').set(admin.auth).expect(200);
    expect(res.body).toMatchObject({ page: 1, pageSize: 1, total: 2 });
    expect(res.body.items[0].slug).toBe('b31-a');
  });
});

describe('IDOR : données de B réellement inchangées (B3.1)', () => {
  it('audit-log, membres et réglages d’un autre collectif : 404 et aucune modification', async () => {
    const settingsBefore = await getDb().organizationSettings.findUniqueOrThrow({ where: { orgId: b.id } });
    const membersBefore = await getDb().membership.findMany({ where: { orgId: b.id }, orderBy: { id: 'asc' } });
    await api().get(`/api/v1/orgs/${b.id}/audit-log`).set(a.owner.auth).expect(404);
    await api().patch(`/api/v1/orgs/${b.id}/members/${b.manager.id}`).set(a.owner.auth).send({ role: 'OWNER' }).expect(404);
    await api().delete(`/api/v1/orgs/${b.id}/members/${b.owner.id}`).set(a.owner.auth).expect(404);
    await api().patch(`/api/v1/orgs/${a.id}/members/${b.manager.id}`).set(a.owner.auth).send({ role: 'OWNER' }).expect(404);
    await api().delete(`/api/v1/orgs/${a.id}/members/${b.owner.id}`).set(a.owner.auth).expect(404);
    await api().patch(`/api/v1/orgs/${b.id}/settings`).set(a.owner.auth).send({ refundPercent: 0 }).expect(404);
    expect(await getDb().organizationSettings.findUniqueOrThrow({ where: { orgId: b.id } })).toEqual(settingsBefore);
    expect(await getDb().membership.findMany({ where: { orgId: b.id }, orderBy: { id: 'asc' } })).toEqual(membersBefore);
    expect(await getDb().auditLog.count({ where: { orgId: b.id } })).toBe(0);
  });

  it('événements et types de B intacts après tentatives via le préfixe de A', async () => {
    const { eventId, ticketTypeIds } = await createEvent(b, { ticketTypes: [{ name: 'Fosse', capacity: 10, priceCents: 1000 }] });
    const eventBefore = await getDb().event.findUniqueOrThrow({ where: { id: eventId }, include: { ticketTypes: true } });
    await api().patch(ev(a, `/${eventId}`)).set(a.owner.auth).send({ title: 'Piraté' }).expect(404);
    await api().post(ev(a, `/${eventId}/publish`)).set(a.owner.auth).expect(404);
    await api().patch(ev(a, `/${eventId}/ticket-types/${ticketTypeIds[0]!}`)).set(a.owner.auth).send({ priceCents: 1 }).expect(404);
    await api().delete(ev(a, `/${eventId}/ticket-types/${ticketTypeIds[0]!}`)).set(a.owner.auth).expect(404);
    expect(await getDb().event.findUniqueOrThrow({ where: { id: eventId }, include: { ticketTypes: true } })).toEqual(eventBefore);
  });
});
