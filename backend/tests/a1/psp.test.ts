import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../../src/lib/db.js';
import { processRefunds } from '../../src/jobs/processRefunds.js';
import { httpPspClient, PspError, setPspClientForTests, type PspClient } from '../../src/lib/psp.js';
import { MAX_REFUND_ATTEMPTS } from '../../src/config/refunds.js';
import { PSP_UNAVAILABLE_RETRY_AFTER_SECONDS } from '../../src/config/payments.js';
import { api, loggedInUser, type LoggedIn } from '../helpers.js';
import { createEvent, orgWithStaff, type OrgFixture } from '../fixtures.js';
import { paymentEvent, postWebhook, startPsp, type PspHarness } from '../psp.js';

let org: OrgFixture;
let buyer: LoggedIn;
let h: PspHarness;

beforeEach(async () => {
  org = await orgWithStaff('collectif-a1-psp');
  buyer = await loggedInUser({ email: 'client-a1-psp@test.fr' });
  h = await startPsp();
});
afterEach(async () => {
  setPspClientForTests(httpPspClient);
  if (h.server.listening) await h.close();
});

async function newOrder() {
  const { eventId, ticketTypeIds } = await createEvent(org, { ticketTypes: [{ name: 'Fosse', capacity: 10, priceCents: 1500 }], publish: true });
  const res = await api().post('/api/v1/orders').set(buyer.auth).set('Idempotency-Key', randomUUID())
    .send({ eventId, paymentMethod: 'CARD', items: [{ ticketTypeId: ticketTypeIds[0]!, quantity: 1 }] }).expect(201);
  return { orderId: res.body.id as string, total: res.body.totalCents as number, eventId };
}
const checkout = (orderId: string) => api().post(`/api/v1/orders/${orderId}/checkout`).set(buyer.auth);

async function expectUnchanged(orderId: string) {
  const order = await getDb().order.findUniqueOrThrow({ where: { id: orderId } });
  expect(order).toMatchObject({ status: 'PENDING_PAYMENT', pspSessionId: null, pspSessionUrl: null, checkoutAttempt: 0 });
  expect(await getDb().pspSession.count({ where: { orderId } })).toBe(0);
}

describe('prestataire de paiement injoignable au checkout (contrat 1.17)', () => {
  it('PSP coupé ⇒ 503 PAYMENT_PROVIDER_UNAVAILABLE + Retry-After, commande inchangée ; PSP revenu ⇒ paiement possible', async () => {
    const o = await newOrder();
    await h.close();
    const res = await checkout(o.orderId);
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('PAYMENT_PROVIDER_UNAVAILABLE');
    expect(res.headers['retry-after']).toBe(String(PSP_UNAVAILABLE_RETRY_AFTER_SECONDS));
    await expectUnchanged(o.orderId);
    h = await startPsp();
    expect((await checkout(o.orderId)).status).toBe(200);
  });

  it('5xx du PSP ou délai dépassé ⇒ 503, commande inchangée ; refus 4xx ⇒ pas un 503', async () => {
    const o = await newOrder();
    for (const failure of [new PspError(502), Object.assign(new Error('délai'), { name: 'TimeoutError' })]) {
      setPspClientForTests({ ...httpPspClient, createCheckoutSession: () => Promise.reject(failure) });
      const res = await checkout(o.orderId);
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('PAYMENT_PROVIDER_UNAVAILABLE');
      await expectUnchanged(o.orderId);
    }
    setPspClientForTests({ ...httpPspClient, createCheckoutSession: () => Promise.reject(new PspError(400)) });
    expect((await checkout(o.orderId)).status).toBe(500);
  });
});

describe('mark-done d’un remboursement carte : PSP interrogé d’abord (contrat 1.17 §7.3 bis)', () => {
  async function manualCardRefund() {
    const o = await newOrder();
    const payment = await getDb().payment.create({ data: { orderId: o.orderId, providerPaymentId: `pay_${randomUUID().slice(0, 8)}`, amountCents: o.total, currency: 'EUR', status: 'SUCCEEDED' } });
    return getDb().refund.create({ data: { orderId: o.orderId, paymentId: payment.id, amountCents: o.total, reason: 'UNEXPECTED_PAYMENT', status: 'MANUAL_REQUIRED' } });
  }
  const markDone = (refundId: string) =>
    api().post(`/api/v1/orgs/${org.id}/refunds/${refundId}/mark-done`).set(org.manager.auth).send({ note: 'remboursé au guichet' });
  const pspFinds = (status: string | null): PspClient => ({
    ...httpPspClient, findRefund: () => Promise.resolve(status === null ? null : { id: 're_psp', status }),
  });

  it('déjà remboursé au PSP ⇒ SUCCEEDED automatiquement, note conservée, audit « vérifié »', async () => {
    const refund = await manualCardRefund();
    setPspClientForTests(pspFinds('succeeded'));
    const res = await markDone(refund.id).expect(200);
    expect(res.body).toMatchObject({ status: 'SUCCEEDED', note: 'remboursé au guichet', method: 'CARD' });
    expect(await getDb().refund.findUniqueOrThrow({ where: { id: refund.id } })).toMatchObject({ providerRefundId: 're_psp' });
    expect((await getDb().auditLog.findFirstOrThrow({ where: { action: 'refund.mark_done' } })).meta).toMatchObject({ verifiedByPsp: true });
  });

  it('encore en cours au PSP ⇒ 409 INVALID_STATE, rien ne change', async () => {
    const refund = await manualCardRefund();
    setPspClientForTests(pspFinds('pending'));
    const res = await markDone(refund.id);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INVALID_STATE');
    expect((await getDb().refund.findUniqueOrThrow({ where: { id: refund.id } })).status).toBe('MANUAL_REQUIRED');
  });

  it('PSP injoignable ⇒ 503 ; inconnu du PSP ⇒ remboursement manuel accepté', async () => {
    const refund = await manualCardRefund();
    await h.close();
    const res = await markDone(refund.id);
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('PAYMENT_PROVIDER_UNAVAILABLE');
    expect((await getDb().refund.findUniqueOrThrow({ where: { id: refund.id } })).status).toBe('MANUAL_REQUIRED');
    setPspClientForTests(pspFinds(null));
    expect((await markDone(refund.id).expect(200)).body.status).toBe('SUCCEEDED');
  });
});

describe('remboursements orphelins visibles par l’admin plateforme (contrat 1.17 §8)', () => {
  it('GET /admin/refunds liste les seuls remboursements sans commande ; mark-done admin ; non-admin ⇒ 404', async () => {
    await postWebhook(paymentEvent(randomUUID(), 4200)).expect(200);
    const orphan = await getDb().refund.findFirstOrThrow({ where: { orderId: null } });
    await getDb().refund.update({ where: { id: orphan.id }, data: { status: 'MANUAL_REQUIRED' } });
    const admin = await loggedInUser({ admin: true });
    const list = await api().get('/api/v1/admin/refunds?status=MANUAL_REQUIRED').set(admin.auth).expect(200);
    expect(list.body.total).toBe(1);
    expect(list.body.items[0]).toMatchObject({ id: orphan.id, orderId: null, eventId: null, eventTitle: null, buyerEmail: null, amountCents: 4200, method: 'CARD' });
    await api().get('/api/v1/admin/refunds').set(org.owner.auth).expect(404);
    setPspClientForTests({ ...httpPspClient, findRefund: () => Promise.resolve(null) });
    const done = await api().post(`/api/v1/admin/refunds/${orphan.id}/mark-done`).set(admin.auth).send({ note: 'remboursé par virement' }).expect(200);
    expect(done.body.status).toBe('SUCCEEDED');
    // Un remboursement d'une commande de collectif n'est pas traitable par cette route.
    expect((await getDb().auditLog.findFirstOrThrow({ where: { action: 'refund.mark_done' } })).orgId).toBeNull();
  });
});

describe('worker : un remboursement « pending » au PSP n’est jamais passé en traitement manuel (B5)', () => {
  async function pendingRefund(attempts: number, providerRefundId: string | null = null) {
    const payment = await getDb().payment.create({ data: { providerPaymentId: `pay_${randomUUID().slice(0, 8)}`, amountCents: 1500, currency: 'EUR', status: 'SUCCEEDED' } });
    return getDb().refund.create({ data: { paymentId: payment.id, amountCents: 1500, reason: 'UNEXPECTED_PAYMENT', status: 'PENDING', attempts, providerRefundId } });
  }

  it('essais épuisés mais toujours « pending » ⇒ reste PENDING (rapprochement périodique)', async () => {
    const refund = await pendingRefund(MAX_REFUND_ATTEMPTS + 3);
    setPspClientForTests({ ...httpPspClient, createRefund: () => Promise.resolve({ id: 're_lent', status: 'pending' }) });
    await processRefunds();
    expect(await getDb().refund.findUniqueOrThrow({ where: { id: refund.id } })).toMatchObject({ status: 'PENDING', providerRefundId: 're_lent' });
  });

  it('déjà accepté par le PSP puis PSP injoignable, essais épuisés ⇒ reste PENDING', async () => {
    const refund = await pendingRefund(MAX_REFUND_ATTEMPTS + 3, 're_accepte');
    setPspClientForTests({ ...httpPspClient, createRefund: () => Promise.reject(new PspError(503)), findRefund: () => Promise.reject(new PspError(503)) });
    await processRefunds();
    expect((await getDb().refund.findUniqueOrThrow({ where: { id: refund.id } })).status).toBe('PENDING');
  });
});
