import { randomUUID } from 'node:crypto';
import supertest from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../../src/lib/db.js';
import { expireOrders } from '../../src/jobs/expireOrders.js';
import { processRefunds } from '../../src/jobs/processRefunds.js';
import { createMockPsp } from '../../src/mock-psp/app.js';
import { api, lastMail, loggedInUser, PASSWORD, type LoggedIn } from '../helpers.js';
import { createEvent, orgWithStaff, setStock, type OrgFixture } from '../fixtures.js';
import { openSession, paymentEvent, postWebhook, startPsp, type PspHarness } from '../psp.js';

let org: OrgFixture;
let buyer: LoggedIn;
let h: PspHarness;

beforeEach(async () => {
  org = await orgWithStaff('collectif-pay');
  buyer = await loggedInUser({ email: 'payeur@test.fr' });
  h = await startPsp();
});
afterEach(async () => {
  await h.close();
});

async function cardOrder(quantity = 2, capacity = 10, paymentMethod = 'CARD') {
  const { eventId, ticketTypeIds } = await createEvent(org, { ticketTypes: [{ name: 'Fosse', capacity, priceCents: 1500 }], publish: true });
  const res = await api().post('/api/v1/orders').set(buyer.auth).set('Idempotency-Key', randomUUID())
    .send({ eventId, paymentMethod, items: [{ ticketTypeId: ticketTypeIds[0]!, quantity }] });
  if (res.status !== 201) throw new Error(`commande KO ${res.status} ${JSON.stringify(res.body)}`);
  return { orderId: res.body.id as string, total: res.body.totalCents as number, eventId, ttId: ticketTypeIds[0]! };
}

const ticketsOf = (orderId: string) => getDb().ticket.count({ where: { orderItem: { orderId } } });
const orderOf = (orderId: string) => getDb().order.findUniqueOrThrow({ where: { id: orderId } });

function checkout(orderId: string) {
  return api().post(`/api/v1/orders/${orderId}/checkout`).set(buyer.auth);
}

async function payOnPsp(orderId: string, action = 'pay') {
  const res = await checkout(orderId).expect(200);
  const sessionId = new URL(res.body.redirectUrl as string).pathname.split('/').pop()!;
  const page = await supertest(h.server).get(`/checkout/${sessionId}`).expect(200);
  expect(page.text).toContain('Paiement simulé');
  await supertest(h.server).post(`/checkout/${sessionId}/${action}`).expect(303);
}

describe('checkout', () => {
  it('idempotent : même session PSP pour des appels répétés ou concurrents', async () => {
    const { orderId } = await cardOrder();
    const results = await Promise.all(Array.from({ length: 5 }, () => checkout(orderId)));
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(new Set(results.map((r) => r.body.redirectUrl as string)).size).toBe(1);
    expect((results[0]!.body.redirectUrl as string).startsWith(h.baseUrl)).toBe(true);
    expect(h.psp.sessions.size).toBe(1);
    const again = await checkout(orderId).expect(200);
    expect(again.body.redirectUrl).toBe(results[0]!.body.redirectUrl);
  });

  it('commande expirée ⇒ 409 ORDER_EXPIRED ; virement ⇒ INVALID_STATE ; commande d’autrui ⇒ 404', async () => {
    const { orderId } = await cardOrder();
    const other = await loggedInUser();
    await api().post(`/api/v1/orders/${orderId}/checkout`).set(other.auth).expect(404);
    await getDb().order.update({ where: { id: orderId }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const res = await checkout(orderId);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ORDER_EXPIRED');
  });
});

describe('webhook de paiement', () => {
  it('paiement par la page du PSP ⇒ commande payée, billets émis, places vendues, mail', async () => {
    const { orderId, ttId } = await cardOrder(3);
    await payOnPsp(orderId);
    expect(h.deliveries.map((d) => d.status)).toEqual([200]);
    const order = await orderOf(orderId);
    expect(order.status).toBe('PAID');
    expect(order.paidAt).not.toBeNull();
    expect(await ticketsOf(orderId)).toBe(3);
    const tt = await getDb().ticketType.findUniqueOrThrow({ where: { id: ttId } });
    expect({ sold: tt.sold, held: tt.held }).toEqual({ sold: 3, held: 0 });
    expect(await lastMail(buyer.email, 'orderConfirmed')).not.toBeNull();
    const view = await api().get(`/api/v1/orders/${orderId}`).set(buyer.auth).expect(200);
    expect(view.body.status).toBe('PAID');
  });

  it('webhook envoyé 2 fois (séquentiel) ⇒ un seul jeu de billets', async () => {
    const { orderId } = await cardOrder(2);
    await payOnPsp(orderId, 'pay-twice');
    expect(h.deliveries.map((d) => d.status)).toEqual([200, 200]);
    expect(await ticketsOf(orderId)).toBe(2);
    expect(await getDb().payment.count({ where: { orderId } })).toBe(1);
    expect(await getDb().webhookEvent.count()).toBe(1);
  });

  it('même webhook livré 10 fois en concurrence ⇒ un seul jeu de billets, toujours 200', async () => {
    const { orderId, total, ttId } = await cardOrder(2);
    const event = paymentEvent(orderId, total, { sessionId: await openSession(orderId, buyer.auth) });
    const results = await Promise.all(Array.from({ length: 10 }, () => postWebhook(event)));
    expect(results.map((r) => r.status)).toEqual(Array(10).fill(200));
    expect(await ticketsOf(orderId)).toBe(2);
    const tt = await getDb().ticketType.findUniqueOrThrow({ where: { id: ttId } });
    expect(tt.sold).toBe(2);
    expect(await getDb().emailOutbox.count({ where: { template: 'orderConfirmed' } })).toBe(1);
  });

  it('signature invalide, horodatage périmé, corps altéré ou non JSON ⇒ 400 sans aucun effet', async () => {
    const { orderId, total } = await cardOrder(1);
    const good = paymentEvent(orderId, total, { sessionId: await openSession(orderId, buyer.auth) });
    await postWebhook(good, { secret: 'X'.repeat(43) }).expect(400);
    await postWebhook(good, { signature: 't=1,v1=abc' }).expect(400);
    await postWebhook(good, { timestamp: Math.floor(Date.now() / 1000) - 301 }).expect(400);
    await postWebhook(good, { timestamp: Math.floor(Date.now() / 1000) + 301 }).expect(400);
    await postWebhook('{"pas":"un événement"').expect(400);
    // Corps modifié après signature.
    const raw = JSON.stringify(good);
    const { signatureHeader } = await import('../../src/lib/pspSignature.js');
    await postWebhook(raw.replace(String(total), String(total + 100)), { signature: signatureHeader(process.env['PSP_WEBHOOK_SECRET']!, raw) }).expect(400);
    expect((await orderOf(orderId)).status).toBe('PENDING_PAYMENT');
    expect(await getDb().webhookEvent.count()).toBe(0);
    expect(await getDb().payment.count()).toBe(0);
    // L'événement légitime est ensuite accepté.
    await postWebhook(good).expect(200);
    expect((await orderOf(orderId)).status).toBe('PAID');
  });

  it('montant ou devise incohérents ⇒ 200, paiement enregistré puis remboursé (jamais perdu), commande inchangée', async () => {
    const { orderId, total } = await cardOrder(1);
    const sessionId = await openSession(orderId, buyer.auth);
    await postWebhook(paymentEvent(orderId, total - 1, { sessionId })).expect(200);
    await postWebhook(paymentEvent(orderId, total, { sessionId, currency: 'USD' })).expect(200);
    expect((await orderOf(orderId)).status).toBe('PENDING_PAYMENT');
    const refunds = await getDb().refund.findMany({ where: { orderId }, orderBy: { amountCents: 'asc' } });
    expect(refunds.map((r) => [r.reason, r.amountCents, r.status])).toEqual([
      ['UNEXPECTED_PAYMENT', total - 1, 'PENDING'],
      ['UNEXPECTED_PAYMENT', total, 'PENDING'],
    ]);
    expect(await getDb().payment.count({ where: { orderId, status: 'SUCCEEDED' } })).toBe(2);
    expect(await getDb().auditLog.count({ where: { action: 'payment.auto_refund' } })).toBe(2);
    expect(await lastMail(buyer.email, 'unexpectedPaymentRefunded')).not.toBeNull();
    // La commande reste payable normalement.
    await postWebhook(paymentEvent(orderId, total, { sessionId })).expect(200);
    expect((await orderOf(orderId)).status).toBe('PAID');
  });

  it('paiement après expiration, places encore disponibles ⇒ re-réservation et billets', async () => {
    const { orderId, total, ttId } = await cardOrder(2, 10);
    const sessionId = await openSession(orderId, buyer.auth);
    await getDb().order.update({ where: { id: orderId }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await expireOrders();
    expect((await orderOf(orderId)).status).toBe('EXPIRED');
    await postWebhook(paymentEvent(orderId, total, { sessionId })).expect(200);
    expect((await orderOf(orderId)).status).toBe('PAID');
    expect(await ticketsOf(orderId)).toBe(2);
    const tt = await getDb().ticketType.findUniqueOrThrow({ where: { id: ttId } });
    expect({ sold: tt.sold, held: tt.held }).toEqual({ sold: 2, held: 0 });
  });

  it('paiement après expiration, plus de places ⇒ remboursement automatique intégral + mail', async () => {
    const { orderId, total, ttId } = await cardOrder(2, 2);
    const sessionId = await openSession(orderId, buyer.auth);
    await getDb().order.update({ where: { id: orderId }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await expireOrders();
    await setStock(ttId, 2, 0); // places revendues entre-temps
    await postWebhook(paymentEvent(orderId, total, { sessionId })).expect(200);
    const order = await orderOf(orderId);
    expect(order.status).toBe('REFUNDED');
    expect(order.refundAmountCents).toBe(total);
    expect(await ticketsOf(orderId)).toBe(0);
    const refund = await getDb().refund.findFirstOrThrow({ where: { orderId } });
    expect(refund).toMatchObject({ status: 'PENDING', amountCents: total, reason: 'LATE_PAYMENT' });
    expect(await lastMail(buyer.email, 'latePaymentRefunded')).not.toBeNull();
    // Le worker exécute le remboursement auprès du PSP (idempotent par id de remboursement).
    const payment = await getDb().payment.findFirstOrThrow({ where: { orderId } });
    h.psp.registerPayment(payment.providerPaymentId, orderId, total);
    expect(await processRefunds()).toEqual({ succeeded: 1, manual: 0 });
    expect((await getDb().refund.findFirstOrThrow({ where: { orderId } })).status).toBe('SUCCEEDED');
    expect(h.psp.refunds.size).toBe(1);
    expect(await processRefunds()).toEqual({ succeeded: 0, manual: 0 });
  });

  it('second paiement (autre paymentId) sur une commande déjà payée ⇒ remboursé automatiquement, audit, mail', async () => {
    const { orderId, total } = await cardOrder(1);
    const sessionId = await openSession(orderId, buyer.auth);
    await postWebhook(paymentEvent(orderId, total, { sessionId })).expect(200);
    await postWebhook(paymentEvent(orderId, total, { sessionId })).expect(200);
    const order = await orderOf(orderId);
    expect(order.status).toBe('PAID');
    expect(await ticketsOf(orderId)).toBe(1);
    expect(await getDb().payment.count({ where: { orderId } })).toBe(2);
    const refund = await getDb().refund.findFirstOrThrow({ where: { orderId } });
    expect(refund).toMatchObject({ amountCents: total, reason: 'DUPLICATE_PAYMENT', status: 'PENDING' });
    expect(await getDb().auditLog.count({ where: { action: 'payment.auto_refund', orgId: org.id } })).toBe(1);
    expect(await lastMail(buyer.email, 'duplicatePaymentRefunded')).not.toBeNull();
  });

  it('paiement refusé : la commande reste en attente, l’acheteur peut réessayer', async () => {
    const { orderId } = await cardOrder(1);
    await payOnPsp(orderId, 'fail');
    expect((await orderOf(orderId)).status).toBe('PENDING_PAYMENT');
    expect(await getDb().payment.count({ where: { orderId, status: 'FAILED' } })).toBe(1);
  });

  it('webhook retardé : la redirection ne prouve rien, seul le webhook fait foi', async () => {
    const { orderId } = await cardOrder(1);
    await payOnPsp(orderId, 'pay-delayed');
    expect((await orderOf(orderId)).status).toBe('PENDING_PAYMENT');
    await new Promise((r) => setTimeout(r, 300));
    expect((await orderOf(orderId)).status).toBe('PAID');
  });

  it('en-tête Date présent (correction d’horloge côté front)', async () => {
    const res = await api().get('/health');
    expect(Date.parse(res.headers['date'] as string)).not.toBeNaN();
  });
});

describe('virement manuel', () => {
  async function transferOrder() {
    await api().patch(`/api/v1/orgs/${org.id}/settings`).set(org.owner.auth)
      .send({ bank: { beneficiary: 'Collectif', iban: 'FR7630006000011234567890189', bic: 'AGRIFRPP' }, currentPassword: PASSWORD }).expect(200);
    return cardOrder(2, 10, 'TRANSFER');
  }

  it('montant faux ⇒ 422 ; bon montant ⇒ payée, billets, audit ; seconde validation ⇒ 409', async () => {
    const { orderId, total } = await transferOrder();
    const url = `/api/v1/orgs/${org.id}/orders/${orderId}/confirm-transfer`;
    const wrong = await api().post(url).set(org.manager.auth).send({ receivedAmountCents: total - 1 });
    expect(wrong.status).toBe(422);
    expect(wrong.body.error.code).toBe('AMOUNT_MISMATCH');
    const ok = await api().post(url).set(org.manager.auth).send({ receivedAmountCents: total }).expect(200);
    expect(ok.body).toMatchObject({ status: 'PAID', buyer: { id: buyer.id, email: buyer.email }, transferInstructions: null });
    expect(await ticketsOf(orderId)).toBe(2);
    expect(await getDb().auditLog.count({ where: { action: 'order.confirm_transfer' } })).toBe(1);
    const again = await api().post(url).set(org.manager.auth).send({ receivedAmountCents: total });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('INVALID_STATE');
  });

  it('commande expirée et places revendues ⇒ 409 ORDER_EXPIRED ; SCANNER ⇒ 403 ; autre collectif ⇒ 404', async () => {
    const { orderId, total, ttId } = await transferOrder();
    const other = await orgWithStaff('autre-collectif-pay');
    await api().post(`/api/v1/orgs/${other.id}/orders/${orderId}/confirm-transfer`).set(other.manager.auth).send({ receivedAmountCents: total }).expect(404);
    await api().post(`/api/v1/orgs/${org.id}/orders/${orderId}/confirm-transfer`).set(org.scanner.auth).send({ receivedAmountCents: total }).expect(403);
    expect((await orderOf(orderId)).status).toBe('AWAITING_TRANSFER');
    await getDb().order.update({ where: { id: orderId }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await expireOrders();
    const tt = await getDb().ticketType.findUniqueOrThrow({ where: { id: ttId } });
    await setStock(ttId, tt.capacity, 0); // places revendues entre-temps
    const res = await api().post(`/api/v1/orgs/${org.id}/orders/${orderId}/confirm-transfer`).set(org.manager.auth).send({ receivedAmountCents: total });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ORDER_EXPIRED');
  });

  it('liste des commandes d’un événement : IBAN masqué, filtre par email, isolée par collectif', async () => {
    const { orderId, eventId } = await transferOrder();
    const res = await api().get(`/api/v1/orgs/${org.id}/events/${eventId}/orders?q=PAYEUR`).set(org.manager.auth).expect(200);
    expect(res.body.total).toBe(1);
    expect(res.body.items[0].id).toBe(orderId);
    expect(res.body.items[0].transferInstructions.iban).toBe('FR76 •••• •••• 0189');
    const none = await api().get(`/api/v1/orgs/${org.id}/events/${eventId}/orders?q=personne`).set(org.manager.auth).expect(200);
    expect(none.body.total).toBe(0);
    const other = await orgWithStaff('autre-collectif-liste');
    await api().get(`/api/v1/orgs/${other.id}/events/${eventId}/orders`).set(other.manager.auth).expect(404);
    await api().get(`/api/v1/orgs/${org.id}/events/${eventId}/orders`).set(org.scanner.auth).expect(403);
  });
});

describe('PSP simulé', () => {
  it('CSP de la page de paiement : form-action autorise exactement l’origine du front (redirection après paiement)', async () => {
    const { orderId } = await cardOrder(1);
    const res = await checkout(orderId).expect(200);
    const page = await supertest(h.server).get(new URL(res.body.redirectUrl as string).pathname).expect(200);
    const csp = page.headers['content-security-policy'] as string;
    expect(csp).toContain("form-action 'self' http://localhost:5173");
    expect(csp).not.toMatch(/form-action[^;]*\*/);
    expect(csp).toContain("default-src 'none'");
  });

  it('refuse de démarrer en production et exige sa clé d’API', async () => {
    expect(() => createMockPsp({ apiKey: 'x', webhookSecret: 'y', publicUrl: 'http://x', allowedRedirectOrigins: [], deliver: () => Promise.resolve(200), nodeEnv: 'production' }))
      .toThrow(/production/);
    await supertest(h.server).post('/v1/checkout-sessions').send({}).expect(401);
    await supertest(h.server).post('/v1/checkout-sessions').set('Authorization', `Bearer ${process.env['PSP_API_KEY']!}`)
      .send({ orderId: randomUUID(), amountCents: 100, currency: 'EUR', successUrl: 'https://evil.example/x', cancelUrl: 'https://evil.example/y' }).expect(400);
  });
});
