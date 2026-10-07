import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_EXPIRE_FAILURES, RECONCILE_CONCURRENCY } from '../../src/config/worker.js';
import { RETENTION } from '../../src/config/retention.js';
import { expireOrders } from '../../src/jobs/expireOrders.js';
import { purgeRetention } from '../../src/jobs/purgeRetention.js';
import { reconcileRecentSessions } from '../../src/jobs/reconcilePayments.js';
import { runWorker } from '../../src/jobs/schedule.js';
import { TimeBudget } from '../../src/lib/budget.js';
import { getDb, transaction } from '../../src/lib/db.js';
import { getLogger } from '../../src/lib/logger.js';
import { enqueueEmail, type MailMessage } from '../../src/lib/outbox.js';
import { httpPspClient, setPspClientForTests } from '../../src/lib/psp.js';
import { api, loggedInUser, type LoggedIn } from '../helpers.js';
import { createEvent, orgWithStaff, type OrgFixture } from '../fixtures.js';

let org: OrgFixture;
let buyer: LoggedIn;

beforeEach(async () => {
  org = await orgWithStaff('collectif-a1-worker');
  buyer = await loggedInUser({ email: 'client-a1-worker@test.fr' });
});
afterEach(() => {
  setPspClientForTests(httpPspClient);
});

async function cardOrder() {
  const { eventId, ticketTypeIds } = await createEvent(org, { ticketTypes: [{ name: 'A', capacity: 50, priceCents: 1000 }], publish: true });
  const res = await api().post('/api/v1/orders').set(buyer.auth).set('Idempotency-Key', randomUUID())
    .send({ eventId, paymentMethod: 'CARD', items: [{ ticketTypeId: ticketTypeIds[0]!, quantity: 1 }] }).expect(201);
  return { orderId: res.body.id as string, eventId };
}

async function withSession(orderId: string, opts: { createdAgoMs?: number; expiresAt?: Date } = {}) {
  const expiresAt = opts.expiresAt ?? new Date(Date.now() + 600_000);
  await getDb().order.update({ where: { id: orderId }, data: { expiresAt } });
  await getDb().pspSession.create({
    data: { id: `cs_${randomBytes(6).toString('hex')}`, orderId, attempt: 0, expiresAt, createdAt: new Date(Date.now() - (opts.createdAgoMs ?? 120_000)) },
  });
}

/** PSP « muet » : chaque consultation de session met `ms` à répondre (open). */
function slowPsp(ms: number, stats = { active: 0, max: 0, calls: 0 }) {
  setPspClientForTests({
    ...httpPspClient,
    getCheckoutSession: async (id) => {
      stats.calls += 1;
      stats.active += 1;
      stats.max = Math.max(stats.max, stats.active);
      await sleep(ms);
      stats.active -= 1;
      return { id, status: 'open', paymentId: null, amountCents: 1000, currency: 'EUR' };
    },
  });
  return stats;
}

describe('worker : un PSP muet ne bloque plus le reste (M3)', () => {
  it('les mails partent pendant qu’un rapprochement attend le PSP ; l’arrêt est pris en compte entre les jobs', async () => {
    const { orderId } = await cardOrder();
    await withSession(orderId, { expiresAt: new Date(Date.now() - 1000) });
    const stats = slowPsp(2500);
    await transaction((tx) => enqueueEmail(tx, 'quelquun@test.fr', 'orderExpired', { displayName: 'Q', eventTitle: 'E' }));
    const sent: MailMessage[] = [];
    const stop = new AbortController();
    const t0 = Date.now();
    const running = runWorker({
      transport: { sendMail: (m: MailMessage) => { sent.push(m); return Promise.resolve(); } },
      intervalMs: 50, signal: stop.signal, logger: getLogger(),
    });
    for (let i = 0; i < 100 && sent.length === 0; i += 1) await sleep(20);
    expect(sent).toHaveLength(1);
    expect(Date.now() - t0).toBeLessThan(2000); // avant la réponse du PSP
    expect(stats.calls).toBeGreaterThan(0);
    stop.abort();
    await running;
    // Le job en cours se termine, les suivants ne sont pas lancés : la commande n'a pas été expirée dans ce passage.
    expect(Date.now() - t0).toBeLessThan(6000);
  }, 15_000);

  it('rapprochement : consultations en parallèle borné', async () => {
    const stats = slowPsp(300);
    for (let i = 0; i < 2 * RECONCILE_CONCURRENCY; i += 1) {
      const { orderId } = await cardOrder();
      await withSession(orderId);
    }
    const t0 = Date.now();
    expect((await reconcileRecentSessions()).checked).toBe(2 * RECONCILE_CONCURRENCY);
    expect(stats.max).toBe(RECONCILE_CONCURRENCY);
    expect(Date.now() - t0).toBeLessThan(2 * RECONCILE_CONCURRENCY * 300);
  });

  it('budget épuisé : aucune commande expirée sans rapprochement, reprise au passage suivant', async () => {
    const { orderId } = await cardOrder();
    await withSession(orderId, { expiresAt: new Date(Date.now() - 1000) });
    slowPsp(10);
    expect((await expireOrders(new TimeBudget(0))).expired).toBe(0);
    expect((await getDb().order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe('PENDING_PAYMENT');
    expect((await expireOrders()).expired).toBe(1);
  });
});

describe('commandes écartées de l’expiration (B2, contrat 1.17 §8)', () => {
  it('succès ⇒ compteur remis à 0 ; écartée ⇒ listée pour l’admin, relancée, puis expirée', async () => {
    const a = await cardOrder();
    await getDb().order.update({ where: { id: a.orderId }, data: { expiresAt: new Date(Date.now() - 1000), expireFailures: MAX_EXPIRE_FAILURES - 1 } });
    await expireOrders();
    expect(await getDb().order.findUniqueOrThrow({ where: { id: a.orderId } })).toMatchObject({ status: 'EXPIRED', expireFailures: 0 });

    const b = await cardOrder();
    await getDb().order.update({ where: { id: b.orderId }, data: { expiresAt: new Date(Date.now() - 1000), expireFailures: MAX_EXPIRE_FAILURES } });
    await expireOrders();
    expect((await getDb().order.findUniqueOrThrow({ where: { id: b.orderId } })).status).toBe('PENDING_PAYMENT');
    const admin = await loggedInUser({ admin: true });
    await api().get('/api/v1/admin/stuck-orders').set(org.owner.auth).expect(404);
    const list = await api().get('/api/v1/admin/stuck-orders').set(admin.auth).expect(200);
    expect(list.body.total).toBe(1);
    expect(list.body.items[0]).toMatchObject({ id: b.orderId, orgId: org.id, buyerEmail: buyer.email, status: 'PENDING_PAYMENT', expireFailures: MAX_EXPIRE_FAILURES });
    const retried = await api().post(`/api/v1/admin/stuck-orders/${b.orderId}/retry`).set(admin.auth).expect(200);
    expect(retried.body.expireFailures).toBe(0);
    expect(await getDb().auditLog.count({ where: { action: 'order.expire_retry', orgId: org.id } })).toBe(1);
    await api().post(`/api/v1/admin/stuck-orders/${b.orderId}/retry`).set(admin.auth).expect(404);
    expect((await expireOrders()).expired).toBe(1);
  });
});

describe('rétention des données (B8)', () => {
  it('purge les lignes au-delà de leur durée, garde les récentes et l’AuditLog', async () => {
    const db = getDb();
    const old = (ms: number) => new Date(Date.now() - ms - 60_000);
    const recent = new Date(Date.now() - 60_000);
    const { orderId, eventId } = await cardOrder();
    for (const [createdAt, status] of [[old(RETENTION.outboxMs), 'SENT'], [old(RETENTION.outboxMs), 'FAILED'], [recent, 'SENT'], [old(RETENTION.outboxMs), 'PENDING']] as const) {
      await db.emailOutbox.create({ data: { to: 'x@test.fr', template: 'orderExpired', payload: {}, status, createdAt } });
    }
    await db.emailToken.createMany({ data: [
      { userId: buyer.id, purpose: 'VERIFY_EMAIL', email: buyer.email, tokenHash: 'a'.repeat(64), expiresAt: old(RETENTION.emailTokensMs) },
      { userId: buyer.id, purpose: 'VERIFY_EMAIL', email: buyer.email, tokenHash: 'b'.repeat(64), expiresAt: new Date(Date.now() + 600_000) },
    ] });
    await db.refreshToken.createMany({ data: [
      { userId: buyer.id, familyId: randomUUID(), tokenHash: 'c'.repeat(64), expiresAt: old(RETENTION.refreshTokensMs) },
      { userId: buyer.id, familyId: randomUUID(), tokenHash: 'd'.repeat(64), expiresAt: new Date(Date.now() + 600_000), revokedAt: old(RETENTION.refreshTokensMs) },
    ] });
    await db.webhookEvent.createMany({ data: [
      { providerEventId: 'evt_vieux', type: 'payment.succeeded', receivedAt: old(RETENTION.webhookEventsMs) },
      { providerEventId: 'evt_recent', type: 'payment.succeeded', receivedAt: recent },
    ] });
    await db.order.update({ where: { id: orderId }, data: { status: 'EXPIRED' } });
    await db.pspSession.create({ data: { id: 'cs_vieux', orderId, attempt: 0, expiresAt: recent, createdAt: old(RETENTION.pspSessionsMs) } });
    await db.event.update({ where: { id: eventId }, data: { endsAt: old(RETENTION.checkInsAfterEventMs), startsAt: old(RETENTION.checkInsAfterEventMs + 3600_000), salesStartAt: old(RETENTION.checkInsAfterEventMs + 7200_000), salesEndAt: old(RETENTION.checkInsAfterEventMs + 3600_000) } });
    await db.checkIn.create({ data: { scanId: randomUUID(), eventId, scannerId: org.scanner.id, deviceId: randomUUID(), scannedAt: recent, result: 'INVALID' } });
    const audits = await db.auditLog.count();

    expect(await purgeRetention()).toEqual({ emailOutbox: 2, emailTokens: 1, refreshTokens: 2, webhookEvents: 1, pspSessions: 1, checkIns: 1, loginLockouts: 0 });
    expect(await db.emailOutbox.count()).toBe(2);
    expect(await db.emailToken.count({ where: { tokenHash: 'b'.repeat(64) } })).toBe(1);
    expect(await db.webhookEvent.count()).toBe(1);
    expect(await db.auditLog.count()).toBe(audits);
  });
});
