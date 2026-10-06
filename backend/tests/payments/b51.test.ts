import { randomUUID } from 'node:crypto';
import supertest from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../../src/lib/db.js';
import { expireOrders } from '../../src/jobs/expireOrders.js';
import { processRefunds } from '../../src/jobs/processRefunds.js';
import { httpPspClient, PspError, setPspClientForTests } from '../../src/lib/psp.js';
import { recordRefund } from '../../src/modules/payments/settle.js';
import { api, lastMail, loggedInUser, PASSWORD, type LoggedIn } from '../helpers.js';
import { createEvent, orgWithStaff, type OrgFixture } from '../fixtures.js';
import { openSession, paymentEvent, postWebhook, startPsp, type PspHarness } from '../psp.js';
import { MAX_REFUND_ATTEMPTS } from '../../src/config/refunds.js';

let org: OrgFixture;
let buyer: LoggedIn;
let h: PspHarness;

beforeEach(async () => {
  org = await orgWithStaff('collectif-b51');
  buyer = await loggedInUser({ email: 'client-b51@test.fr' });
  h = await startPsp();
});
afterEach(async () => {
  setPspClientForTests(httpPspClient);
  await h.close();
});

async function cardOrder(quantity = 1, capacity = 10, paymentMethod = 'CARD') {
  const { eventId, ticketTypeIds } = await createEvent(org, { ticketTypes: [{ name: 'Fosse', capacity, priceCents: 1500 }], publish: true });
  const res = await api().post('/api/v1/orders').set(buyer.auth).set('Idempotency-Key', randomUUID())
    .send({ eventId, paymentMethod, items: [{ ticketTypeId: ticketTypeIds[0]!, quantity }] }).expect(201);
  return { orderId: res.body.id as string, total: res.body.totalCents as number, eventId, ttId: ticketTypeIds[0]! };
}
const orderOf = (id: string) => getDb().order.findUniqueOrThrow({ where: { id } });

describe('un paiement authentifié n’est jamais perdu (B5.1 H1 / H3 / M1 / M2)', () => {
  it('commande inconnue ⇒ 200, paiement enregistré sans commande puis remboursé, alerte', async () => {
    const res = await postWebhook(paymentEvent(randomUUID(), 4200));
    expect(res.status).toBe(200);
    const payment = await getDb().payment.findFirstOrThrow();
    expect(payment).toMatchObject({ orderId: null, amountCents: 4200, status: 'SUCCEEDED' });
    expect(await getDb().refund.findFirstOrThrow()).toMatchObject({ orderId: null, amountCents: 4200, reason: 'UNEXPECTED_PAYMENT', status: 'PENDING' });
    expect(await getDb().auditLog.findFirstOrThrow({ where: { action: 'payment.auto_refund' } })).toMatchObject({ orgId: null });
    // Identifiant de commande mal formé : même traitement.
    await postWebhook(paymentEvent('pas-un-uuid', 100)).expect(200);
    expect(await getDb().refund.count()).toBe(2);
  });

  it('stock bloqué incohérent sur une commande en attente ⇒ 200, remboursement, aucune boucle', async () => {
    const { orderId, total, ttId } = await cardOrder(2);
    const sessionId = await openSession(orderId, buyer.auth);
    await getDb().ticketType.update({ where: { id: ttId }, data: { held: 0 } });
    await postWebhook(paymentEvent(orderId, total, { sessionId })).expect(200);
    expect((await orderOf(orderId)).status).toBe('PENDING_PAYMENT');
    expect(await getDb().refund.findFirstOrThrow({ where: { orderId } })).toMatchObject({ reason: 'UNEXPECTED_PAYMENT', amountCents: total });
    expect(await getDb().ticket.count()).toBe(0);
  });

  it('type d’événement inconnu ou champ inconnu dans data ⇒ 200 ; enveloppe signée inexploitable ⇒ 200', async () => {
    await postWebhook(JSON.stringify({ id: 'evt_inconnu1', type: 'dispute.created', created: 1, data: { paymentId: 'pay_x', orderId: 'x', amountCents: 1, currency: 'EUR' } })).expect(200);
    expect(await getDb().webhookEvent.count({ where: { type: 'dispute.created' } })).toBe(1);
    const { orderId, total } = await cardOrder(1);
    const sessionId = await openSession(orderId, buyer.auth);
    const event = paymentEvent(orderId, total, { sessionId });
    await postWebhook({ ...event, data: { ...event.data, nouveauChamp: 'toléré' } } as never).expect(200);
    expect((await orderOf(orderId)).status).toBe('PAID');
    await postWebhook('{"sans":"identifiant"}').expect(200);
  });

  it('session de paiement absente ou différente ⇒ remboursé, commande inchangée', async () => {
    const { orderId, total } = await cardOrder(1);
    await postWebhook(paymentEvent(orderId, total)).expect(200);
    await openSession(orderId, buyer.auth);
    await postWebhook(paymentEvent(orderId, total, { sessionId: 'cs_autreSession' })).expect(200);
    expect((await orderOf(orderId)).status).toBe('PENDING_PAYMENT');
    expect(await getDb().refund.count({ where: { orderId, reason: 'UNEXPECTED_PAYMENT' } })).toBe(2);
  });

  it('paiement carte sur une commande par virement ⇒ remboursé', async () => {
    await api().patch(`/api/v1/orgs/${org.id}/settings`).set(org.owner.auth)
      .send({ bank: { beneficiary: 'C', iban: 'FR7630006000011234567890189', bic: 'AGRIFRPP' }, currentPassword: PASSWORD }).expect(200);
    const { orderId, total } = await cardOrder(1, 10, 'TRANSFER');
    await postWebhook(paymentEvent(orderId, total)).expect(200);
    expect((await orderOf(orderId)).status).toBe('AWAITING_TRANSFER');
    expect(await getDb().refund.count({ where: { orderId } })).toBe(1);
  });

  it('paiement tardif alors que des personnes attendent en liste d’attente ⇒ pas de reprise, remboursement', async () => {
    const { orderId, total, ttId, eventId } = await cardOrder(1, 10);
    const sessionId = await openSession(orderId, buyer.auth);
    await getDb().order.update({ where: { id: orderId }, data: { expiresAt: new Date(Date.now() - 60_000) } });
    await expireOrders();
    const waiting = await loggedInUser();
    await getDb().waitlistEntry.create({ data: { ticketTypeId: ttId, eventId, userId: waiting.id, quantity: 1 } });
    await postWebhook(paymentEvent(orderId, total, { sessionId })).expect(200);
    expect((await orderOf(orderId)).status).toBe('REFUNDED');
    expect(await getDb().refund.findFirstOrThrow({ where: { orderId } })).toMatchObject({ reason: 'LATE_PAYMENT' });
  });
});

describe('séquences de paiement (B5.1 H2 / M3)', () => {
  it('payment.failed puis payment.succeeded pour le même paymentId sur la MÊME session ⇒ payée, aucun remboursement (B9 M2)', async () => {
    const { orderId, total } = await cardOrder(1);
    const sessionId = await openSession(orderId, buyer.auth);
    await postWebhook(paymentEvent(orderId, total, { type: 'payment.failed', paymentId: 'pay_meme', sessionId })).expect(200);
    // Le refus a libéré la session côté commande (nouvelle tentative possible), mais elle reste dans l'historique.
    expect((await orderOf(orderId)).pspSessionId).toBeNull();
    await postWebhook(paymentEvent(orderId, total, { paymentId: 'pay_meme', sessionId })).expect(200);
    expect((await orderOf(orderId)).status).toBe('PAID');
    expect(await getDb().refund.count()).toBe(0);
    expect(await getDb().payment.findFirstOrThrow({ where: { providerPaymentId: 'pay_meme' } })).toMatchObject({ status: 'SUCCEEDED' });
  });

  it('après « Refuser » sur la page du PSP, le checkout ouvre une NOUVELLE session et le paiement aboutit', async () => {
    const { orderId } = await cardOrder(1);
    const first = await api().post(`/api/v1/orders/${orderId}/checkout`).set(buyer.auth).expect(200);
    const s1 = new URL(first.body.redirectUrl as string).pathname.split('/').pop()!;
    await supertest(h.server).post(`/checkout/${s1}/fail`).expect(303);
    const second = await api().post(`/api/v1/orders/${orderId}/checkout`).set(buyer.auth).expect(200);
    expect(second.body.redirectUrl).not.toBe(first.body.redirectUrl);
    const s2 = new URL(second.body.redirectUrl as string).pathname.split('/').pop()!;
    await supertest(h.server).post(`/checkout/${s2}/pay`).expect(303);
    expect((await orderOf(orderId)).status).toBe('PAID');
    expect(await getDb().refund.count()).toBe(0);
  });
});

describe('exécution des remboursements (B5.1 M4 / M5 / M7)', () => {
  async function paidThenDuplicate() {
    const { orderId, total } = await cardOrder(1);
    const sessionId = await openSession(orderId, buyer.auth);
    await postWebhook(paymentEvent(orderId, total, { sessionId })).expect(200);
    await postWebhook(paymentEvent(orderId, total, { sessionId, paymentId: 'pay_doublon' })).expect(200);
    return { orderId, total };
  }

  it('refund.succeeded apparié par identifiant PSP : connu, inconnu, dupliqué', async () => {
    const { orderId, total } = await paidThenDuplicate();
    h.psp.registerPayment('pay_doublon', orderId, total);
    expect(await processRefunds()).toEqual({ succeeded: 1, manual: 0 });
    const refund = await getDb().refund.findFirstOrThrow({ where: { orderId } });
    expect(refund.providerRefundId).toMatch(/^re_/);
    // Un succès tardif régularise un remboursement passé en MANUAL_REQUIRED.
    await getDb().refund.update({ where: { id: refund.id }, data: { status: 'MANUAL_REQUIRED' } });
    const ev = { id: 'evt_refund1', type: 'refund.succeeded' as const, created: 1, data: { paymentId: 'pay_doublon', refundId: refund.providerRefundId!, orderId, amountCents: total, currency: 'EUR' } };
    await postWebhook(ev).expect(200);
    await postWebhook(ev).expect(200);
    expect((await getDb().refund.findUniqueOrThrow({ where: { id: refund.id } })).status).toBe('SUCCEEDED');
    await postWebhook({ ...ev, id: 'evt_refund2', data: { ...ev.data, refundId: 're_inconnu' } }).expect(200);
  });

  it('refus définitif du PSP (4xx) ⇒ MANUAL_REQUIRED immédiat', async () => {
    const { orderId } = await paidThenDuplicate(); // paiement inconnu du PSP ⇒ 404
    expect(await processRefunds()).toEqual({ succeeded: 0, manual: 1 });
    expect(await getDb().refund.findFirstOrThrow({ where: { orderId } })).toMatchObject({ status: 'MANUAL_REQUIRED', attempts: 1, lastError: 'PSP 404' });
  });

  it('essais épuisés sur erreurs transitoires ⇒ MANUAL_REQUIRED, jamais un échec silencieux', async () => {
    const { orderId } = await paidThenDuplicate();
    setPspClientForTests({ ...httpPspClient, createRefund: () => Promise.reject(new PspError(503)) });
    await getDb().refund.updateMany({ data: { attempts: MAX_REFUND_ATTEMPTS - 1 } });
    expect(await processRefunds()).toEqual({ succeeded: 0, manual: 1 });
    expect(await getDb().refund.findFirstOrThrow({ where: { orderId } })).toMatchObject({ status: 'MANUAL_REQUIRED', lastError: 'PSP 503' });
  });

  it('bail : la tentative est comptée avant l’appel, un remboursement interrompu est repris', async () => {
    const { orderId, total } = await paidThenDuplicate();
    // « Crash » pendant l'appel : le bail est posé, la tentative comptée, puis le processus s'arrête.
    setPspClientForTests({ ...httpPspClient, createRefund: () => Promise.reject(new Error('processus tué')) });
    expect(await processRefunds()).toEqual({ succeeded: 0, manual: 0 });
    let refund = await getDb().refund.findFirstOrThrow({ where: { orderId } });
    expect(refund).toMatchObject({ status: 'PENDING', attempts: 1 });
    expect(await processRefunds()).toEqual({ succeeded: 0, manual: 0 }); // bail en cours : pas repris
    await getDb().refund.update({ where: { id: refund.id }, data: { nextAttemptAt: new Date(Date.now() - 60_000) } });
    setPspClientForTests(httpPspClient);
    h.psp.registerPayment('pay_doublon', orderId, total);
    expect(await processRefunds()).toEqual({ succeeded: 1, manual: 0 });
    refund = await getDb().refund.findFirstOrThrow({ where: { orderId } });
    expect(refund).toMatchObject({ status: 'SUCCEEDED', attempts: 2 });
  });

  it('plafond : jamais plus que le paiement, même via des enregistrements successifs', async () => {
    const { orderId, total } = await paidThenDuplicate();
    const payment = await getDb().payment.findFirstOrThrow({ where: { providerPaymentId: 'pay_doublon' } });
    const amount = await getDb().$transaction((tx) => recordRefund(tx, { orderId, paymentId: payment.id, providerPaymentId: payment.providerPaymentId, amountCents: total, reason: 'UNEXPECTED_PAYMENT' }));
    expect(amount).toBe(0); // déjà intégralement remboursé (doublon)
    const sum = await getDb().refund.aggregate({ where: { paymentId: payment.id }, _sum: { amountCents: true } });
    expect(sum._sum.amountCents).toBe(total);
  });

  it('PSP simulé : paiement inconnu ⇒ 404, plafond cumulé ⇒ 422, même clé + corps différent ⇒ 409', async () => {
    const auth = `Bearer ${process.env['PSP_API_KEY']!}`;
    await supertest(h.server).post('/v1/refunds').set('Authorization', auth).set('Idempotency-Key', 'k1').send({ paymentId: 'pay_x', amountCents: 10 }).expect(404);
    h.psp.registerPayment('pay_y', randomUUID(), 1000);
    await supertest(h.server).post('/v1/refunds').set('Authorization', auth).set('Idempotency-Key', 'k2').send({ paymentId: 'pay_y', amountCents: 800 }).expect(201);
    await supertest(h.server).post('/v1/refunds').set('Authorization', auth).set('Idempotency-Key', 'k2').send({ paymentId: 'pay_y', amountCents: 800 }).expect(200);
    await supertest(h.server).post('/v1/refunds').set('Authorization', auth).set('Idempotency-Key', 'k2').send({ paymentId: 'pay_y', amountCents: 100 }).expect(409);
    await supertest(h.server).post('/v1/refunds').set('Authorization', auth).set('Idempotency-Key', 'k3').send({ paymentId: 'pay_y', amountCents: 300 }).expect(422);
  });
});

describe('validation de virement (B5.1 M6)', () => {
  async function transferOrder() {
    await api().patch(`/api/v1/orgs/${org.id}/settings`).set(org.owner.auth)
      .send({ bank: { beneficiary: 'C', iban: 'FR7630006000011234567890189', bic: 'AGRIFRPP' }, currentPassword: PASSWORD }).expect(200);
    return cardOrder(1, 10, 'TRANSFER');
  }
  const confirm = (orderId: string, total: number) =>
    api().post(`/api/v1/orgs/${org.id}/orders/${orderId}/confirm-transfer`).set(org.manager.auth).send({ receivedAmountCents: total });

  it('échéance dépassée (worker pas encore passé) et ventes closes ⇒ 409 ORDER_EXPIRED ; événement annulé ⇒ 409 SALES_CLOSED', async () => {
    const a = await transferOrder();
    await getDb().order.update({ where: { id: a.orderId }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await getDb().event.update({ where: { id: a.eventId }, data: { salesEndAt: new Date(Date.now() - 500) } });
    const res = await confirm(a.orderId, a.total);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ORDER_EXPIRED');
    const b = await cardOrder(1, 10, 'TRANSFER');
    await getDb().event.update({ where: { id: b.eventId }, data: { status: 'CANCELLED' } });
    const closed = await confirm(b.orderId, b.total);
    expect(closed.status).toBe(409);
    expect(closed.body.error.code).toBe('SALES_CLOSED');
  });

  it('validation concurrente à l’expiration : jamais les deux, stock cohérent', async () => {
    for (let i = 0; i < 3; i += 1) {
      const o = await transferOrder();
      await getDb().order.update({ where: { id: o.orderId }, data: { expiresAt: new Date(Date.now() + 300) } });
      await new Promise((r) => setTimeout(r, 300));
      const [res] = await Promise.all([confirm(o.orderId, o.total), expireOrders()]);
      const final = await orderOf(o.orderId);
      const tt = await getDb().ticketType.findUniqueOrThrow({ where: { id: o.ttId } });
      if (res.status === 200) {
        expect(final.status).toBe('PAID');
        expect({ sold: tt.sold, held: tt.held }).toEqual({ sold: 1, held: 0 });
      } else {
        expect(res.body.error.code).toBe('ORDER_EXPIRED');
        expect(final.status).not.toBe('PAID');
        expect(tt.sold).toBe(0);
      }
    }
  });
});

describe('suivi des remboursements par l’organisateur (B5.1 M8)', () => {
  it('liste filtrable, marquage manuel tracé, isolation entre collectifs', async () => {
    await api().patch(`/api/v1/orgs/${org.id}/settings`).set(org.owner.auth)
      .send({ bank: { beneficiary: 'C', iban: 'FR7630006000011234567890189', bic: 'AGRIFRPP' }, currentPassword: PASSWORD }).expect(200);
    const o = await cardOrder(1, 10, 'TRANSFER');
    await api().post(`/api/v1/orgs/${org.id}/orders/${o.orderId}/confirm-transfer`).set(org.manager.auth).send({ receivedAmountCents: o.total }).expect(200);
    // Second virement reçu pour la même commande : remboursement manuel (virement).
    const payment = await getDb().payment.create({ data: { orderId: o.orderId, providerPaymentId: `transfer:${o.orderId}:2`, amountCents: o.total, currency: 'EUR', status: 'SUCCEEDED' } });
    await getDb().$transaction((tx) => recordRefund(tx, { orderId: o.orderId, paymentId: payment.id, providerPaymentId: payment.providerPaymentId, amountCents: o.total, reason: 'DUPLICATE_PAYMENT' }));
    const list = await api().get(`/api/v1/orgs/${org.id}/refunds?status=MANUAL_REQUIRED`).set(org.manager.auth).expect(200);
    expect(list.body.total).toBe(1);
    const item = list.body.items[0] as { id: string };
    expect(list.body.items[0]).toMatchObject({ orderId: o.orderId, eventId: o.eventId, buyerEmail: buyer.email, method: 'TRANSFER', status: 'MANUAL_REQUIRED', reason: 'DUPLICATE_PAYMENT', note: null });
    const other = await orgWithStaff('autre-b51');
    await api().get(`/api/v1/orgs/${other.id}/refunds`).set(other.manager.auth).expect(200).expect((r) => { expect(r.body.total).toBe(0); });
    await api().post(`/api/v1/orgs/${other.id}/refunds/${item.id}/mark-done`).set(other.manager.auth).send({ note: 'x' }).expect(404);
    await api().post(`/api/v1/orgs/${org.id}/refunds/${item.id}/mark-done`).set(org.scanner.auth).send({ note: 'x' }).expect(403);
    const done = await api().post(`/api/v1/orgs/${org.id}/refunds/${item.id}/mark-done`).set(org.manager.auth).send({ note: 'Virement retour le 12/10' }).expect(200);
    expect(done.body).toMatchObject({ status: 'SUCCEEDED', note: 'Virement retour le 12/10' });
    const again = await api().post(`/api/v1/orgs/${org.id}/refunds/${item.id}/mark-done`).set(org.manager.auth).send({ note: 'x' });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('INVALID_STATE');
    expect(await getDb().auditLog.count({ where: { action: 'refund.mark_done', orgId: org.id } })).toBe(1);
    expect(await lastMail(buyer.email, 'orderConfirmed')).not.toBeNull();
  });

  it('recherche par email : % et _ traités comme du texte', async () => {
    const o = await cardOrder(1);
    const res = await api().get(`/api/v1/orgs/${org.id}/events/${o.eventId}/orders?q=%25`).set(org.manager.auth).expect(200);
    expect(res.body.total).toBe(0);
    const ok = await api().get(`/api/v1/orgs/${org.id}/events/${o.eventId}/orders?q=client-b51`).set(org.manager.auth).expect(200);
    expect(ok.body.total).toBe(1);
  });
});
