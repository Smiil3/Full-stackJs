import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import supertest from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../../src/lib/db.js';
import { expireOrders } from '../../src/jobs/expireOrders.js';
import { processRefunds } from '../../src/jobs/processRefunds.js';
import { reconcileRecentSessions } from '../../src/jobs/reconcilePayments.js';
import { httpPspClient, PspError, setPspClientForTests, type PspClient } from '../../src/lib/psp.js';
import { createMockPsp } from '../../src/mock-psp/app.js';
import { api, PASSWORD, loggedInUser, type LoggedIn } from '../helpers.js';
import { createEvent, orgWithStaff, setStock, type OrgFixture } from '../fixtures.js';
import { openSession, paymentEvent, postWebhook, startPsp, type PspHarness } from '../psp.js';
import { MAX_REFUND_ATTEMPTS } from '../../src/config/refunds.js';
import { RECONCILE_GRACE_MS } from '../../src/config/payments.js';

let org: OrgFixture;
let buyer: LoggedIn;
let h: PspHarness;

beforeEach(async () => {
  org = await orgWithStaff('collectif-b9');
  buyer = await loggedInUser({ email: 'client-b9@test.fr' });
  h = await startPsp();
});
afterEach(async () => {
  setPspClientForTests(httpPspClient);
  await h.close();
});

async function newOrder(quantity = 1, capacity = 10, paymentMethod = 'CARD', who: LoggedIn = buyer, eventId?: string) {
  let ev = eventId;
  let ttId: string;
  if (ev) {
    ttId = (await getDb().ticketType.findFirstOrThrow({ where: { eventId: ev } })).id;
  } else {
    const created = await createEvent(org, { ticketTypes: [{ name: 'Fosse', capacity, priceCents: 1500 }], publish: true });
    ev = created.eventId;
    ttId = created.ticketTypeIds[0]!;
  }
  const res = await api().post('/api/v1/orders').set(who.auth).set('Idempotency-Key', randomUUID())
    .send({ eventId: ev, paymentMethod, items: [{ ticketTypeId: ttId, quantity }] }).expect(201);
  return { orderId: res.body.id as string, total: res.body.totalCents as number, eventId: ev, ttId };
}
const orderOf = (id: string) => getDb().order.findUniqueOrThrow({ where: { id } });
const past = (ms = 1000) => new Date(Date.now() - ms);

/** Commande carte avec session ouverte, puis expirée par le worker. */
async function expiredWithSession(quantity = 1, capacity = 10) {
  const o = await newOrder(quantity, capacity);
  const sessionId = await openSession(o.orderId, buyer.auth);
  await getDb().order.update({ where: { id: o.orderId }, data: { expiresAt: past() } });
  await expireOrders();
  expect((await orderOf(o.orderId)).status).toBe('EXPIRED');
  return { ...o, sessionId };
}

async function expectLateRefund(orderId: string, total: number, reason = 'LATE_PAYMENT') {
  const order = await orderOf(orderId);
  expect(order.status).toBe('REFUNDED');
  expect(order.refundAmountCents).toBe(total);
  expect(await getDb().refund.findFirstOrThrow({ where: { orderId } })).toMatchObject({ reason, amountCents: total });
  expect(await getDb().ticket.count({ where: { orderItem: { orderId } } })).toBe(0);
}

describe('paiement tardif : toutes les règles de vente revérifiées (B9 H1)', () => {
  it('places libres et règles respectées ⇒ reprise au prix figé', async () => {
    const o = await expiredWithSession(2);
    await getDb().ticketType.update({ where: { id: o.ttId }, data: { priceCents: 9900 } });
    await postWebhook(paymentEvent(o.orderId, o.total, { sessionId: o.sessionId })).expect(200);
    const order = await orderOf(o.orderId);
    expect(order.status).toBe('PAID');
    expect(order.totalCents).toBe(o.total);
    expect(await getDb().ticket.count({ where: { orderItem: { orderId: o.orderId } } })).toBe(2);
  });

  it('ventes closes ⇒ remboursement intégral LATE_PAYMENT', async () => {
    const o = await expiredWithSession();
    await getDb().event.update({ where: { id: o.eventId }, data: { salesEndAt: past(500) } });
    await postWebhook(paymentEvent(o.orderId, o.total, { sessionId: o.sessionId })).expect(200);
    await expectLateRefund(o.orderId, o.total);
  });

  it('événement commencé ⇒ remboursement intégral LATE_PAYMENT', async () => {
    const o = await expiredWithSession();
    await getDb().event.update({ where: { id: o.eventId }, data: { startsAt: past(500), salesEndAt: past(500) } });
    await postWebhook(paymentEvent(o.orderId, o.total, { sessionId: o.sessionId })).expect(200);
    await expectLateRefund(o.orderId, o.total);
  });

  it('événement annulé ⇒ remboursement intégral', async () => {
    const o = await expiredWithSession();
    await getDb().event.update({ where: { id: o.eventId }, data: { status: 'CANCELLED' } });
    await postWebhook(paymentEvent(o.orderId, o.total, { sessionId: o.sessionId })).expect(200);
    expect(await getDb().refund.findFirstOrThrow({ where: { orderId: o.orderId } })).toMatchObject({ reason: 'EVENT_CANCELLED', amountCents: o.total });
    expect((await orderOf(o.orderId)).status).not.toBe('PAID');
  });

  it('plus de places ⇒ remboursement intégral LATE_PAYMENT', async () => {
    const o = await expiredWithSession(1, 3);
    await setStock(o.ttId, 3, 0);
    await postWebhook(paymentEvent(o.orderId, o.total, { sessionId: o.sessionId })).expect(200);
    await expectLateRefund(o.orderId, o.total);
  });

  it('plafond par personne dépassé entre-temps ⇒ remboursement intégral LATE_PAYMENT', async () => {
    const o = await expiredWithSession(2);
    // Une autre commande du même acheteur occupe désormais le plafond.
    await newOrder(1, 10, 'CARD', buyer, o.eventId);
    await getDb().event.update({ where: { id: o.eventId }, data: { maxPerUser: 2, maxPerOrder: 2 } });
    await postWebhook(paymentEvent(o.orderId, o.total, { sessionId: o.sessionId })).expect(200);
    await expectLateRefund(o.orderId, o.total);
  });

  it('échéance dépassée, worker pas encore passé, ventes closes ⇒ remboursé et places libérées', async () => {
    const o = await newOrder(2);
    const sessionId = await openSession(o.orderId, buyer.auth);
    await getDb().order.update({ where: { id: o.orderId }, data: { expiresAt: past(5000) } });
    await getDb().event.update({ where: { id: o.eventId }, data: { salesEndAt: past(500) } });
    await postWebhook(paymentEvent(o.orderId, o.total, { sessionId })).expect(200);
    await expectLateRefund(o.orderId, o.total);
    expect((await getDb().ticketType.findUniqueOrThrow({ where: { id: o.ttId } })).held).toBe(0);
  });

  it('échéance dépassée, worker pas encore passé, règles respectées ⇒ payée', async () => {
    const o = await newOrder(1);
    const sessionId = await openSession(o.orderId, buyer.auth);
    await getDb().order.update({ where: { id: o.orderId }, data: { expiresAt: past(5000) } });
    await postWebhook(paymentEvent(o.orderId, o.total, { sessionId })).expect(200);
    expect((await orderOf(o.orderId)).status).toBe('PAID');
  });

  it('mock : la session porte l’échéance de la commande et refuse tout paiement après', async () => {
    const o = await newOrder(1);
    const sessionId = await openSession(o.orderId, buyer.auth);
    const order = await orderOf(o.orderId);
    const session = h.psp.sessions.get(sessionId)!;
    expect(session.expiresAt).toBe(order.expiresAt!.getTime());
    session.expiresAt = Date.now() - 1;
    const res = await supertest(h.server).post(`/checkout/${sessionId}/pay`).expect(303);
    expect(res.headers['location']).toContain('payment=failed');
    await sleep(100);
    expect(await getDb().payment.count()).toBe(0);
    expect((await orderOf(o.orderId)).status).toBe('PENDING_PAYMENT');
  });
});

describe('rapprochement des paiements (B9 M1)', () => {
  it('webhook perdu ⇒ la commande passe PAID par rapprochement avant expiration ; le webhook tardif est sans effet', async () => {
    const o = await newOrder(2);
    const sessionId = await openSession(o.orderId, buyer.auth);
    // Paiement fait côté PSP, mais la notification n'arrive jamais.
    Object.assign(h.psp.sessions.get(sessionId)!, { status: 'paid', paymentId: 'pay_perdu' });
    await getDb().order.update({ where: { id: o.orderId }, data: { expiresAt: past() } });
    const result = await expireOrders();
    expect(result.expired).toBe(0);
    expect((await orderOf(o.orderId)).status).toBe('PAID');
    expect(await getDb().ticket.count({ where: { orderItem: { orderId: o.orderId } } })).toBe(2);
    await postWebhook(paymentEvent(o.orderId, o.total, { sessionId, paymentId: 'pay_perdu' })).expect(200);
    expect(await getDb().refund.count()).toBe(0);
    expect(await getDb().payment.count()).toBe(1);
  });

  it('job de rapprochement : session récente payée sans webhook ⇒ PAID sans attendre l’échéance', async () => {
    const o = await newOrder(1);
    const sessionId = await openSession(o.orderId, buyer.auth);
    Object.assign(h.psp.sessions.get(sessionId)!, { status: 'paid', paymentId: 'pay_recent' });
    expect((await reconcileRecentSessions()).checked).toBe(0); // session trop récente
    await getDb().pspSession.update({ where: { id: sessionId }, data: { createdAt: past(120_000) } });
    expect(await reconcileRecentSessions()).toEqual({ checked: 1, paid: 1 });
    expect((await orderOf(o.orderId)).status).toBe('PAID');
  });

  it('PSP injoignable ⇒ expiration différée, puis expirée après le délai de grâce', async () => {
    const o = await newOrder(1);
    await openSession(o.orderId, buyer.auth);
    setPspClientForTests({ ...httpPspClient, getCheckoutSession: () => Promise.reject(new PspError(503)) });
    await getDb().order.update({ where: { id: o.orderId }, data: { expiresAt: past() } });
    expect((await expireOrders()).expired).toBe(0);
    await getDb().order.update({ where: { id: o.orderId }, data: { expiresAt: past(RECONCILE_GRACE_MS + 1000) } });
    expect((await expireOrders()).expired).toBe(1);
  });

  it('mock : une livraison non acquittée est réessayée', async () => {
    const statuses = [500, 200];
    let calls = 0;
    const psp = createMockPsp({
      apiKey: 'k'.repeat(32), webhookSecret: 's'.repeat(32), publicUrl: 'http://127.0.0.1:1', allowedRedirectOrigins: ['http://localhost:5173'],
      nodeEnv: 'test', retryDelaysMs: [10, 10],
      deliver: () => Promise.resolve(statuses[calls++] ?? 200),
    });
    await psp.emit({ id: 'evt_retry', type: 'payment.succeeded', created: 0, data: { paymentId: 'pay_r', orderId: 'o', amountCents: 1, currency: 'EUR' } });
    expect(psp.pendingRetries()).toBe(1);
    for (let i = 0; i < 50 && calls < 2; i += 1) await sleep(10);
    expect(calls).toBe(2);
    expect(psp.pendingRetries()).toBe(0);
  });
});

describe('remboursements : statut du PSP vérifié (B9 M4)', () => {
  async function pendingRefund(attempts = 0) {
    const payment = await getDb().payment.create({ data: { providerPaymentId: `pay_${randomUUID().slice(0, 8)}`, amountCents: 1500, currency: 'EUR', status: 'SUCCEEDED' } });
    return getDb().refund.create({ data: { paymentId: payment.id, amountCents: 1500, reason: 'UNEXPECTED_PAYMENT', status: 'PENDING', attempts } });
  }

  it('« pending » ⇒ reste PENDING, puis refund.succeeded rapproché par la clé d’idempotence', async () => {
    const refund = await pendingRefund();
    setPspClientForTests({ ...httpPspClient, createRefund: () => Promise.resolve({ id: 're_attente', status: 'pending' }) });
    await processRefunds();
    expect(await getDb().refund.findUniqueOrThrow({ where: { id: refund.id } })).toMatchObject({ status: 'PENDING', providerRefundId: 're_attente' });
    // Réponse perdue : le webhook porte un autre id PSP mais notre clé d'idempotence.
    await getDb().refund.update({ where: { id: refund.id }, data: { providerRefundId: null } });
    await postWebhook({ id: 'evt_refund_key', type: 'refund.succeeded', created: Math.floor(Date.now() / 1000),
      data: { paymentId: 'pay_x', refundId: 're_final', idempotencyKey: refund.id, orderId: 'x', amountCents: 1500, currency: 'EUR' } }).expect(200);
    expect(await getDb().refund.findUniqueOrThrow({ where: { id: refund.id } })).toMatchObject({ status: 'SUCCEEDED', providerRefundId: 're_final' });
  });

  it('« failed » ⇒ MANUAL_REQUIRED, jamais SUCCEEDED', async () => {
    const refund = await pendingRefund();
    setPspClientForTests({ ...httpPspClient, createRefund: () => Promise.resolve({ id: 're_ko', status: 'failed' }) });
    await processRefunds();
    expect((await getDb().refund.findUniqueOrThrow({ where: { id: refund.id } })).status).toBe('MANUAL_REQUIRED');
  });

  it('erreurs réseau épuisées mais remboursement retrouvé par sa clé ⇒ SUCCEEDED, pas MANUAL_REQUIRED', async () => {
    const refund = await pendingRefund(MAX_REFUND_ATTEMPTS - 1);
    const client: PspClient = {
      ...httpPspClient,
      createRefund: () => Promise.reject(new PspError(503)),
      findRefund: (key) => Promise.resolve(key === refund.id ? { id: 're_trouve', status: 'succeeded' } : null),
    };
    setPspClientForTests(client);
    await processRefunds();
    expect(await getDb().refund.findUniqueOrThrow({ where: { id: refund.id } })).toMatchObject({ status: 'SUCCEEDED', providerRefundId: 're_trouve' });
  });

  it('mock : GET /v1/refunds?idempotencyKey retrouve un remboursement exécuté', async () => {
    h.psp.registerPayment('pay_mock', randomUUID(), 1000);
    const auth = `Bearer ${process.env['PSP_API_KEY']!}`;
    await supertest(h.server).post('/v1/refunds').set('Authorization', auth).set('Idempotency-Key', 'cle-1').send({ paymentId: 'pay_mock', amountCents: 400 }).expect(201);
    const found = await httpPspClient.findRefund('cle-1');
    expect(found?.status).toBe('succeeded');
    expect(await httpPspClient.findRefund('cle-inconnue')).toBeNull();
  });
});

describe('report et commandes non payées ; virement tardif (B9 M3)', () => {
  async function enableTransfer() {
    await api().patch(`/api/v1/orgs/${org.id}/settings`).set(org.owner.auth)
      .send({ bank: { beneficiary: 'C', iban: 'FR7630006000011234567890189', bic: 'AGRIFRPP' }, currentPassword: PASSWORD }).expect(200);
  }

  it('report : commandes en attente ⇒ 100 %, nouveau cancellableUntil, expiresAt ramené au nouveau début', async () => {
    await enableTransfer();
    const o = await newOrder(1, 10, 'TRANSFER');
    const event = await getDb().event.findUniqueOrThrow({ where: { id: o.eventId } });
    const newStart = new Date(Date.now() + 2 * 3600_000);
    await getDb().order.update({ where: { id: o.orderId }, data: { expiresAt: new Date(Date.now() + 48 * 3600_000) } });
    await api().patch(`/api/v1/orgs/${org.id}/events/${o.eventId}`).set(org.owner.auth)
      .send({ startsAt: newStart.toISOString(), endsAt: new Date(newStart.getTime() + 3600_000).toISOString(), salesEndAt: newStart.toISOString(), rescheduleReason: 'Salle indisponible' })
      .expect(200);
    const order = await orderOf(o.orderId);
    expect(order.refundPercent).toBe(100);
    expect(order.serviceFeeRefundable).toBe(true);
    expect(order.expiresAt!.getTime()).toBe(newStart.getTime());
    expect(event.startsAt.getTime()).not.toBe(newStart.getTime());
  });

  it('virement validé après l’échéance, règles respectées ⇒ payé (avant ou après le passage du worker)', async () => {
    await enableTransfer();
    const a = await newOrder(1, 10, 'TRANSFER');
    await getDb().order.update({ where: { id: a.orderId }, data: { expiresAt: past() } });
    const confirm = (id: string, total: number) =>
      api().post(`/api/v1/orgs/${org.id}/orders/${id}/confirm-transfer`).set(org.manager.auth).send({ receivedAmountCents: total });
    expect((await confirm(a.orderId, a.total)).status).toBe(200);
    const b = await newOrder(1, 10, 'TRANSFER', buyer, a.eventId);
    await getDb().order.update({ where: { id: b.orderId }, data: { expiresAt: past() } });
    await expireOrders();
    expect((await orderOf(b.orderId)).status).toBe('EXPIRED');
    expect((await confirm(b.orderId, b.total)).status).toBe(200);
    expect((await orderOf(b.orderId)).status).toBe('PAID');
    expect((await getDb().ticketType.findUniqueOrThrow({ where: { id: a.ttId } })).sold).toBe(2);
  });
});

describe('checkout et lecture des commandes (B9 B1 / B3)', () => {
  it('checkout sur un événement commencé ou dépublié ⇒ 409 SALES_CLOSED', async () => {
    const o = await newOrder(1);
    await getDb().event.update({ where: { id: o.eventId }, data: { startsAt: past(), salesEndAt: past() } });
    const res = await api().post(`/api/v1/orders/${o.orderId}/checkout`).set(buyer.auth);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('SALES_CLOSED');
  });

  it('IBAN de commande indéchiffrable ⇒ instructions masquées, jamais de 500 (liste, détail, annulation)', async () => {
    await api().patch(`/api/v1/orgs/${org.id}/settings`).set(org.owner.auth)
      .send({ bank: { beneficiary: 'C', iban: 'FR7630006000011234567890189', bic: 'AGRIFRPP' }, currentPassword: PASSWORD }).expect(200);
    const o = await newOrder(1, 10, 'TRANSFER');
    await getDb().order.update({ where: { id: o.orderId }, data: { transferIbanEncrypted: 'v1:corrompu' } });
    const one = await api().get(`/api/v1/orders/${o.orderId}`).set(buyer.auth).expect(200);
    expect(one.body.transferInstructions).toBeNull();
    const list = await api().get('/api/v1/orders').set(buyer.auth).expect(200);
    expect(list.body.items[0].transferInstructions).toBeNull();
    await api().post(`/api/v1/orders/${o.orderId}/cancel`).set(buyer.auth).expect(200);
  });
});

describe('paymentInProgress (contrat 1.16)', () => {
  it('vrai seulement avec une session ouverte, non refusée, non échue ; visible acheteur et back-office', async () => {
    const o = await newOrder(1);
    const view = () => api().get(`/api/v1/orders/${o.orderId}`).set(buyer.auth).expect(200);
    expect((await view()).body.paymentInProgress).toBe(false);
    const first = await api().post(`/api/v1/orders/${o.orderId}/checkout`).set(buyer.auth).expect(200);
    expect((await view()).body.paymentInProgress).toBe(true);
    // Reprendre le paiement : MÊME session.
    const again = await api().post(`/api/v1/orders/${o.orderId}/checkout`).set(buyer.auth).expect(200);
    expect(again.body.redirectUrl).toBe(first.body.redirectUrl);
    const admin = await api().get(`/api/v1/orgs/${org.id}/events/${o.eventId}/orders`).set(org.manager.auth).expect(200);
    expect(admin.body.items[0].paymentInProgress).toBe(true);
    const list = await api().get('/api/v1/orders').set(buyer.auth).expect(200);
    expect(list.body.items[0].paymentInProgress).toBe(true);
    // Échue.
    const { expiresAt } = await orderOf(o.orderId);
    await getDb().order.update({ where: { id: o.orderId }, data: { expiresAt: past() } });
    expect((await view()).body.paymentInProgress).toBe(false);
    await getDb().order.update({ where: { id: o.orderId }, data: { expiresAt } });
    // Refusée : session oubliée.
    const sessionId = (await orderOf(o.orderId)).pspSessionId!;
    await postWebhook(paymentEvent(o.orderId, o.total, { type: 'payment.failed', sessionId })).expect(200);
    expect((await view()).body.paymentInProgress).toBe(false);
    // Payée.
    await postWebhook(paymentEvent(o.orderId, o.total, { sessionId })).expect(200);
    const paid = (await view()).body;
    expect(paid.status).toBe('PAID');
    expect(paid.paymentInProgress).toBe(false);
  });
});
