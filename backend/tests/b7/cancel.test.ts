import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../../src/lib/db.js';
import { processEventCancellations } from '../../src/jobs/processEventCancellations.js';
import { testClock } from '../../src/lib/clock.js';
import { api, lastMail, loggedInUser, PASSWORD, type LoggedIn } from '../helpers.js';
import { createEvent, orgWithStaff, type OrgFixture } from '../fixtures.js';
import { openSession, paymentEvent, postWebhook, startPsp, type PspHarness } from '../psp.js';

let org: OrgFixture;
let buyer: LoggedIn;
let h: PspHarness;

beforeEach(async () => {
  org = await orgWithStaff('collectif-cancel');
  buyer = await loggedInUser({ email: 'annule@test.fr' });
  h = await startPsp();
});
afterEach(async () => {
  testClock.reset();
  await h.close();
});

/** Commande carte payée via webhook signé. */
async function paidOrder(opts: { quantity?: number; overrides?: Record<string, unknown>; settings?: Record<string, unknown>; who?: LoggedIn; eventId?: string; ttId?: string } = {}) {
  if (opts.settings) await api().patch(`/api/v1/orgs/${org.id}/settings`).set(org.owner.auth).send(opts.settings).expect(200);
  let eventId = opts.eventId;
  let ttId = opts.ttId;
  if (!eventId || !ttId) {
    const ev = await createEvent(org, { ticketTypes: [{ name: 'Fosse', capacity: 50, priceCents: 2000 }, { name: 'Balcon', capacity: 50, priceCents: 1500 }], publish: true, body: { overrides: opts.overrides ?? {} } });
    eventId = ev.eventId;
    ttId = ev.ticketTypeIds[0]!;
  }
  const who = opts.who ?? buyer;
  const res = await api().post('/api/v1/orders').set(who.auth).set('Idempotency-Key', randomUUID())
    .send({ eventId, paymentMethod: 'CARD', items: [{ ticketTypeId: ttId, quantity: opts.quantity ?? 2 }] }).expect(201);
  const orderId = res.body.id as string;
  const sessionId = await openSession(orderId, who.auth);
  await postWebhook(paymentEvent(orderId, res.body.totalCents as number, { sessionId })).expect(200);
  return { orderId, eventId, ttId, total: res.body.totalCents as number };
}

const cancel = (orderId: string, who: LoggedIn = buyer) => api().post(`/api/v1/orders/${orderId}/cancel`).set(who.auth);

describe('annulation self-service', () => {
  it('non payée ⇒ CANCELLED, places libérées, aucun remboursement', async () => {
    const ev = await createEvent(org, { ticketTypes: [{ name: 'A', capacity: 10, priceCents: 1000 }], publish: true });
    const res = await api().post('/api/v1/orders').set(buyer.auth).set('Idempotency-Key', randomUUID())
      .send({ eventId: ev.eventId, paymentMethod: 'CARD', items: [{ ticketTypeId: ev.ticketTypeIds[0]!, quantity: 3 }] }).expect(201);
    const out = await cancel(res.body.id as string).expect(200);
    expect(out.body).toMatchObject({ status: 'CANCELLED', refundAmountCents: 0, refundPreviewCents: null });
    expect((await getDb().ticketType.findUniqueOrThrow({ where: { id: ev.ticketTypeIds[0]! } })).held).toBe(0);
    expect(await getDb().refund.count()).toBe(0);
  });

  it('payée : remboursement au bon pourcentage, ÉGAL à l’aperçu refundPreviewCents', async () => {
    const { orderId, total } = await paidOrder({ quantity: 3, settings: { refundPercent: 75, serviceFeeFixedCents: 99, serviceFeeBasisPoints: 250 } });
    const before = await api().get(`/api/v1/orders/${orderId}`).set(buyer.auth).expect(200);
    // floor(6000 × 75 / 100) = 4500 ; frais non remboursables par défaut.
    expect(before.body.refundPreviewCents).toBe(4500);
    expect(total).toBe(6000 + 99 + 150);
    const out = await cancel(orderId).expect(200);
    expect(out.body).toMatchObject({ status: 'REFUNDED', refundAmountCents: before.body.refundPreviewCents, refundPreviewCents: null });
    const refund = await getDb().refund.findFirstOrThrow({ where: { orderId } });
    expect(refund).toMatchObject({ amountCents: 4500, reason: 'SELF_CANCELLATION', status: 'PENDING' });
    const items = await getDb().orderItem.findMany({ where: { orderId } });
    expect(items.reduce((n, i) => n + i.refundedCents, 0)).toBe(4500);
    expect(await lastMail(buyer.email, 'orderRefunded')).not.toBeNull();
  });

  it('frais remboursables : ajoutés au remboursement (même fonction que l’aperçu)', async () => {
    const { orderId, total } = await paidOrder({ quantity: 1, settings: { refundPercent: 50, serviceFeeFixedCents: 100, serviceFeeRefundable: true } });
    const preview = (await api().get(`/api/v1/orders/${orderId}`).set(buyer.auth)).body.refundPreviewCents as number;
    expect(preview).toBe(1000 + 100);
    const out = await cancel(orderId).expect(200);
    expect(out.body.refundAmountCents).toBe(preview);
    expect(total).toBe(2100);
  });

  it('billets annulés : un billet de commande remboursée est refusé à l’entrée (scan CANCELLED)', async () => {
    const { orderId, eventId } = await paidOrder({ quantity: 2 });
    const tickets = (await api().get('/api/v1/me/tickets').set(buyer.auth)).body.items as { qrPayload: string }[];
    await cancel(orderId).expect(200);
    await getDb().event.update({ where: { id: eventId }, data: { offlineCheckinEnabled: true } });
    const scan = await api().post(`/api/v1/orgs/${org.id}/events/${eventId}/checkin/scan`).set(org.scanner.auth)
      .send({ qrPayload: tickets[0]!.qrPayload, deviceId: randomUUID(), scanId: randomUUID() }).expect(200);
    expect(scan.body.result).toBe('CANCELLED');
    const snap = await api().get(`/api/v1/orgs/${org.id}/events/${eventId}/checkin/snapshot`).set(org.scanner.auth).expect(200);
    expect((snap.body.tickets as { status: string }[]).every((t) => t.status === 'CANCELLED')).toBe(true);
  });

  it('après le délai ⇒ 409 CANCELLATION_CLOSED (aperçu null)', async () => {
    const { orderId } = await paidOrder();
    const order = await getDb().order.findUniqueOrThrow({ where: { id: orderId } });
    testClock.freeze(new Date(order.cancellableUntil!.getTime() + 1));
    const view = await api().get(`/api/v1/orders/${orderId}`).set(buyer.auth).expect(200);
    expect(view.body.refundPreviewCents).toBeNull();
    const res = await cancel(orderId);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CANCELLATION_CLOSED');
    testClock.freeze(new Date(order.cancellableUntil!.getTime() - 1));
    await cancel(orderId).expect(200);
  });

  it('après un scan ⇒ 409 CANCELLATION_CLOSED', async () => {
    const { orderId, eventId } = await paidOrder();
    const tickets = (await api().get('/api/v1/me/tickets').set(buyer.auth)).body.items as { qrPayload: string }[];
    await api().post(`/api/v1/orgs/${org.id}/events/${eventId}/checkin/scan`).set(org.scanner.auth)
      .send({ qrPayload: tickets[0]!.qrPayload, deviceId: randomUUID(), scanId: randomUUID() }).expect(200);
    expect((await api().get(`/api/v1/orders/${orderId}`).set(buyer.auth)).body.refundPreviewCents).toBeNull();
    const res = await cancel(orderId);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CANCELLATION_CLOSED');
  });

  it('annulation désactivée ⇒ 409 ; commande d’autrui ⇒ 404 ; déjà remboursée ⇒ 409 INVALID_STATE', async () => {
    const disabled = await paidOrder({ overrides: { selfCancellationEnabled: false } });
    expect((await cancel(disabled.orderId)).body.error.code).toBe('CANCELLATION_CLOSED');
    const ok = await paidOrder();
    await cancel(ok.orderId, await loggedInUser()).expect(404);
    await cancel(ok.orderId).expect(200);
    const again = await cancel(ok.orderId);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('INVALID_STATE');
  });

  it('les places rendues vont d’abord à la liste d’attente', async () => {
    const ev = await createEvent(org, { ticketTypes: [{ name: 'A', capacity: 2, priceCents: 1000 }], publish: true });
    const { orderId } = await paidOrder({ eventId: ev.eventId, ttId: ev.ticketTypeIds[0]!, quantity: 2 });
    const waiting = await loggedInUser();
    await api().post(`/api/v1/events/${ev.eventId}/ticket-types/${ev.ticketTypeIds[0]!}/waitlist`).set(waiting.auth).send({ quantity: 1 }).expect(201);
    await cancel(orderId).expect(200);
    const view = await api().get('/api/v1/me/waitlist').set(waiting.auth).expect(200);
    expect(view.body.items[0].status).toBe('OFFERED');
  });

  it('second paiement remboursé sur commande PAID : la commande reste PAID, billets VALID (B6.1 H1c)', async () => {
    const { orderId, total } = await paidOrder({ quantity: 1 });
    const order = await getDb().order.findUniqueOrThrow({ where: { id: orderId } });
    await postWebhook(paymentEvent(orderId, total, { sessionId: order.pspSessionId })).expect(200);
    expect((await getDb().order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe('PAID');
    expect(await getDb().ticket.count({ where: { orderItem: { orderId }, status: 'VALID' } })).toBe(1);
  });
});

describe('annulation d’un événement', () => {
  it('OWNER : payées remboursées à 100 % frais compris, en attente annulées, liste d’attente close, billets annulés, mails', async () => {
    const ev = await createEvent(org, { ticketTypes: [{ name: 'A', capacity: 3, priceCents: 2000 }], publish: true, body: { overrides: { serviceFeeFixedCents: 150, refundPercent: 20 } } });
    const paid = await paidOrder({ eventId: ev.eventId, ttId: ev.ticketTypeIds[0]!, quantity: 2 });
    const other = await loggedInUser();
    const pending = await api().post('/api/v1/orders').set(other.auth).set('Idempotency-Key', randomUUID())
      .send({ eventId: ev.eventId, paymentMethod: 'CARD', items: [{ ticketTypeId: ev.ticketTypeIds[0]!, quantity: 1 }] }).expect(201);
    const waiting = await loggedInUser();
    await api().post(`/api/v1/events/${ev.eventId}/ticket-types/${ev.ticketTypeIds[0]!}/waitlist`).set(waiting.auth).send({ quantity: 1 }).expect(201);
    await api().post(`/api/v1/orgs/${org.id}/events/${ev.eventId}/cancel`).set(org.manager.auth).send({ reason: 'Intempéries' }).expect(403);
    const res = await api().post(`/api/v1/orgs/${org.id}/events/${ev.eventId}/cancel`).set(org.owner.auth).send({ reason: 'Intempéries' }).expect(200);
    expect(res.body).toMatchObject({ status: 'CANCELLED', cancellationPendingOrders: 2 });
    expect(await processEventCancellations()).toEqual({ processed: 2, failed: 0 });
    const paidAfter = await getDb().order.findUniqueOrThrow({ where: { id: paid.orderId } });
    expect(paidAfter).toMatchObject({ status: 'REFUNDED', refundAmountCents: paid.total });
    expect(paid.total).toBe(4150);
    expect(await getDb().refund.findFirstOrThrow({ where: { orderId: paid.orderId } })).toMatchObject({ amountCents: 4150, reason: 'EVENT_CANCELLED' });
    expect((await getDb().order.findUniqueOrThrow({ where: { id: pending.body.id as string } })).status).toBe('CANCELLED');
    expect(await getDb().ticket.count({ where: { eventId: ev.eventId, status: { not: 'CANCELLED' } } })).toBe(0);
    expect(await getDb().waitlistEntry.count({ where: { eventId: ev.eventId, status: { in: ['WAITING', 'OFFERED'] } } })).toBe(0);
    const tt = await getDb().ticketType.findUniqueOrThrow({ where: { id: ev.ticketTypeIds[0]! } });
    expect({ sold: tt.sold, held: tt.held }).toEqual({ sold: 0, held: 0 });
    expect(await lastMail(buyer.email, 'eventCancelled')).not.toBeNull();
    expect(await lastMail(other.email, 'eventCancelled')).not.toBeNull();
    expect(await getDb().auditLog.count({ where: { action: 'event.cancel' } })).toBe(1);
    // Idempotent : un 2e appel renvoie le même état.
    const again = await api().post(`/api/v1/orgs/${org.id}/events/${ev.eventId}/cancel`).set(org.owner.auth).send({ reason: 'x' }).expect(200);
    expect(again.body).toMatchObject({ status: 'CANCELLED', cancellationPendingOrders: 0 });
    // Plus aucune vente possible.
    const late = await api().post('/api/v1/orders').set(other.auth).set('Idempotency-Key', randomUUID())
      .send({ eventId: ev.eventId, paymentMethod: 'CARD', items: [{ ticketTypeId: ev.ticketTypeIds[0]!, quantity: 1 }] });
    expect(late.body.error.code).toBe('SALES_CLOSED');
  });

  it('virement payé ⇒ remboursement MANUAL_REQUIRED, visible des organisateurs', async () => {
    await api().patch(`/api/v1/orgs/${org.id}/settings`).set(org.owner.auth)
      .send({ bank: { beneficiary: 'C', iban: 'FR7630006000011234567890189', bic: 'AGRIFRPP' }, currentPassword: PASSWORD }).expect(200);
    const ev = await createEvent(org, { ticketTypes: [{ name: 'A', capacity: 3, priceCents: 2000 }], publish: true });
    const res = await api().post('/api/v1/orders').set(buyer.auth).set('Idempotency-Key', randomUUID())
      .send({ eventId: ev.eventId, paymentMethod: 'TRANSFER', items: [{ ticketTypeId: ev.ticketTypeIds[0]!, quantity: 1 }] }).expect(201);
    await api().post(`/api/v1/orgs/${org.id}/orders/${res.body.id as string}/confirm-transfer`).set(org.manager.auth).send({ receivedAmountCents: 2000 }).expect(200);
    await api().post(`/api/v1/orgs/${org.id}/events/${ev.eventId}/cancel`).set(org.owner.auth).send({ reason: 'Salle fermée' }).expect(200);
    await processEventCancellations();
    const list = await api().get(`/api/v1/orgs/${org.id}/refunds?status=MANUAL_REQUIRED`).set(org.manager.auth).expect(200);
    expect(list.body.items[0]).toMatchObject({ method: 'TRANSFER', reason: 'EVENT_CANCELLED', amountCents: 2000 });
  });
});
