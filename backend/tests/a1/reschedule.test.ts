import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_RESCHEDULE_FAILURES, STUCK_RESCHEDULE_AFTER_MS } from '../../src/config/worker.js';
import { expireOrders } from '../../src/jobs/expireOrders.js';
import { testClock } from '../../src/lib/clock.js';
import { getDb } from '../../src/lib/db.js';
import { processEventReschedules } from '../../src/modules/events/reschedule.js';
import { api, expectDefined, loggedInUser, PASSWORD, type LoggedIn } from '../helpers.js';
import { createEvent, orgWithStaff, type OrgFixture } from '../fixtures.js';

let org: OrgFixture;
let buyer: LoggedIn;

beforeEach(async () => {
  org = await orgWithStaff('collectif-report');
  buyer = await loggedInUser({ email: 'client-report@test.fr' });
});
afterEach(() => {
  testClock.reset();
});

const ev = (path = '') => `/api/v1/orgs/${org.id}/events${path}`;

/** Événement à 30 jours, auto-annulation à 50 % jusqu'à 48 h avant, virement activé. */
async function eventWithRules() {
  await api().patch(`/api/v1/orgs/${org.id}/settings`).set(org.owner.auth)
    .send({ refundPercent: 50, bank: { beneficiary: 'C', iban: 'FR7630006000011234567890189', bic: 'AGRIFRPP' }, currentPassword: PASSWORD }).expect(200);
  return createEvent(org, { ticketTypes: [{ name: 'A', capacity: 10, priceCents: 2000 }], publish: true });
}

async function newOrder(eventId: string, ttId: string, paymentMethod: 'CARD' | 'TRANSFER') {
  const res = await api().post('/api/v1/orders').set(buyer.auth).set('Idempotency-Key', randomUUID())
    .send({ eventId, paymentMethod, items: [{ ticketTypeId: ttId, quantity: 1 }] }).expect(201);
  return res.body as { id: string; totalCents: number; refundPercent: number };
}

async function reschedule(eventId: string, days = 7, extra: Record<string, unknown> = {}) {
  const e = await getDb().event.findUniqueOrThrow({ where: { id: eventId } });
  const start = new Date(e.startsAt.getTime() + days * 86400_000);
  await api().patch(ev(`/${eventId}`)).set(org.owner.auth).send({
    startsAt: start.toISOString(), endsAt: new Date(start.getTime() + 3600_000).toISOString(), salesEndAt: start.toISOString(),
    rescheduleReason: 'Salle indisponible', ...extra,
  }).expect(200);
  return start;
}

describe('report : les droits ne se perdent jamais (audit M\'3)', () => {
  it('commande expirée AVANT le passage du worker puis virement reçu en retard ⇒ payée AVEC les droits du report', async () => {
    const { eventId, ticketTypeIds } = await eventWithRules();
    const order = await newOrder(eventId, ticketTypeIds[0]!, 'TRANSFER');
    expect(order.refundPercent).toBe(50);
    await reschedule(eventId);
    // Le worker de report n'est pas passé ; l'échéance tombe : expiration.
    await getDb().order.update({ where: { id: order.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await expireOrders()).expired).toBe(1);
    const expired = await getDb().order.findUniqueOrThrow({ where: { id: order.id } });
    expect(expired).toMatchObject({ status: 'EXPIRED', refundPercent: 100, serviceFeeRefundable: true, pendingRescheduleId: null });
    // Virement reçu en retard, places encore libres : reprise.
    const res = await api().post(`/api/v1/orgs/${org.id}/orders/${order.id}/confirm-transfer`).set(org.manager.auth).send({ receivedAmountCents: order.totalCents });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'PAID', refundPercent: 100 });
  });

  it('paiement d’une commande pas encore traitée par le worker : droits appliqués au verrouillage', async () => {
    const { eventId, ticketTypeIds } = await eventWithRules();
    const order = await newOrder(eventId, ticketTypeIds[0]!, 'TRANSFER');
    await reschedule(eventId);
    const res = await api().post(`/api/v1/orgs/${org.id}/orders/${order.id}/confirm-transfer`).set(org.manager.auth).send({ receivedAmountCents: order.totalCents }).expect(200);
    expect(res.body.refundPercent).toBe(100);
    expect((await getDb().order.findUniqueOrThrow({ where: { id: order.id } })).pendingRescheduleId).toBeNull();
  });

  it('aperçu à jour dès le report, compteur reschedulePendingOrders jusqu’au passage du worker', async () => {
    const { eventId, ticketTypeIds } = await eventWithRules();
    const order = await newOrder(eventId, ticketTypeIds[0]!, 'CARD');
    const newStart = await reschedule(eventId, 7, { title: 'Nouveau titre' });
    const view = (await api().get(`/api/v1/orders/${order.id}`).set(buyer.auth).expect(200)).body;
    expect(view.refundPercent).toBe(100);
    expect(new Date(view.cancellableUntil as string).getTime()).toBeGreaterThan(newStart.getTime() - 3 * 86400_000);
    expect((await api().get(ev(`/${eventId}`)).set(org.manager.auth).expect(200)).body.reschedulePendingOrders).toBe(1);
    await processEventReschedules();
    expect((await api().get(ev(`/${eventId}`)).set(org.manager.auth).expect(200)).body.reschedulePendingOrders).toBe(0);
    // Le PATCH-report trace aussi les autres champs modifiés (Info audit n° 2).
    const audit = await getDb().auditLog.findFirstOrThrow({ where: { action: 'event.update', target: `event:${eventId}` }, orderBy: { createdAt: 'desc' } });
    expect((audit.meta as { fields: string[] }).fields).toContain('title');
  });
});

describe('reports bloqués visibles et relançables par l’admin plateforme (audit B\'6, contrat 1.18 §8)', () => {
  /** Déclencheur de TEST : toute application d'un report (pendingRescheduleId vidé) échoue. */
  async function sabotage() {
    await getDb().$executeRaw`
      CREATE OR REPLACE FUNCTION test_block_reschedule() RETURNS trigger AS $$
      BEGIN
        IF OLD."pendingRescheduleId" IS NOT NULL AND NEW."pendingRescheduleId" IS NULL THEN
          RAISE EXCEPTION 'échec simulé';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql`;
    await getDb().$executeRaw`CREATE TRIGGER test_block_reschedule BEFORE UPDATE ON "orders" FOR EACH ROW EXECUTE FUNCTION test_block_reschedule()`;
  }
  async function unsabotage() {
    await getDb().$executeRaw`DROP TRIGGER IF EXISTS test_block_reschedule ON "orders"`;
    await getDb().$executeRaw`DROP FUNCTION IF EXISTS test_block_reschedule()`;
  }
  afterEach(unsabotage);

  it(`commande en échec ${MAX_RESCHEDULE_FAILURES} fois ⇒ écartée, report listé ; relance ⇒ traité et terminé`, async () => {
    const { eventId, ticketTypeIds } = await eventWithRules();
    await newOrder(eventId, ticketTypeIds[0]!, 'CARD');
    await reschedule(eventId);
    await sabotage();
    for (let i = 0; i < MAX_RESCHEDULE_FAILURES; i += 1) expect((await processEventReschedules()).failed).toBe(1);
    // Écartée : plus réessayée à chaque passage.
    expect(await processEventReschedules()).toMatchObject({ processed: 0, failed: 0, completed: 0 });
    const admin = await loggedInUser({ admin: true });
    await api().get('/api/v1/admin/stuck-reschedules').set(org.owner.auth).expect(404);
    const list = (await api().get('/api/v1/admin/stuck-reschedules').set(admin.auth).expect(200)).body;
    expect(list.total).toBe(1);
    const stuck = expectDefined(list.items[0] as { id: string } | undefined, 'report bloqué listé');
    expect(stuck).toMatchObject({ eventId, orgId: org.id, pendingOrders: 1, failedOrders: 1, reason: 'Salle indisponible' });
    await unsabotage();
    const retried = (await api().post(`/api/v1/admin/stuck-reschedules/${stuck.id}/retry`).set(admin.auth).expect(200)).body;
    expect(retried.failedOrders).toBe(0);
    expect(await getDb().auditLog.count({ where: { action: 'event.reschedule_retry', orgId: org.id } })).toBe(1);
    expect(await processEventReschedules()).toMatchObject({ processed: 1, completed: 1 });
    await api().post(`/api/v1/admin/stuck-reschedules/${stuck.id}/retry`).set(admin.auth).expect(404);
  });

  it('worker arrêté : un report non terminé depuis plus de 15 min est listé, sans commande en échec', async () => {
    const { eventId, ticketTypeIds } = await eventWithRules();
    await newOrder(eventId, ticketTypeIds[0]!, 'CARD');
    await reschedule(eventId);
    const admin = await loggedInUser({ admin: true });
    expect((await api().get('/api/v1/admin/stuck-reschedules').set(admin.auth).expect(200)).body.total).toBe(0);
    testClock.freeze(new Date(Date.now() + STUCK_RESCHEDULE_AFTER_MS + 60_000));
    const list = (await api().get('/api/v1/admin/stuck-reschedules').set(admin.auth).expect(200)).body;
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({ eventId, pendingOrders: 1, failedOrders: 0 });
  });
});
