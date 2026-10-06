import { randomBytes, randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../../src/lib/db.js';
import { testClock } from '../../src/lib/clock.js';
import { createApp } from '../../src/app.js';
import { csvCell } from '../../src/lib/csv.js';
import { renderTemplate } from '../../src/lib/mail/templates.js';
import { expireOrders } from '../../src/jobs/expireOrders.js';
import { processEventCancellations } from '../../src/jobs/processEventCancellations.js';
import { api, loggedInUser, PASSWORD, type LoggedIn } from '../helpers.js';
import { createEvent, orgWithStaff, type OrgFixture } from '../fixtures.js';
import { openSession, paymentEvent, postWebhook, startPsp, type PspHarness } from '../psp.js';

let org: OrgFixture;
let h: PspHarness;

beforeEach(async () => {
  org = await orgWithStaff('collectif-b71');
  h = await startPsp();
});
afterEach(async () => {
  testClock.reset();
  await h.close();
});

const order = (who: LoggedIn, eventId: string, ttId: string, quantity = 1, paymentMethod = 'CARD') =>
  api().post('/api/v1/orders').set(who.auth).set('Idempotency-Key', randomUUID()).send({ eventId, paymentMethod, items: [{ ticketTypeId: ttId, quantity }] });
const cancelEvent = (eventId: string) => api().post(`/api/v1/orgs/${org.id}/events/${eventId}/cancel`).set(org.owner.auth).send({ reason: 'Annulation' });

async function payCard(who: LoggedIn, orderId: string, total: number) {
  const sessionId = await openSession(orderId, who.auth);
  await postWebhook(paymentEvent(orderId, total, { sessionId })).expect(200);
}

/** 1 000 commandes payées insérées directement (volume réaliste d'un grand événement). */
async function bulkPaidOrders(eventId: string, ttId: string, n: number) {
  const db = getDb();
  const users = await db.user.createManyAndReturn({
    data: Array.from({ length: n }, (_, i) => ({ email: `bulk${i}-${randomUUID().slice(0, 6)}@test.fr`, displayName: `B${i}`, passwordHash: 'x', emailVerifiedAt: new Date() })),
    select: { id: true },
  });
  const orders = users.map((u) => ({ id: randomUUID(), userId: u.id }));
  await db.order.createMany({
    data: orders.map((o) => ({
      id: o.id, userId: o.userId, eventId, status: 'PAID' as const, paymentMethod: 'CARD' as const, idempotencyKey: randomUUID(), requestHash: '0'.repeat(64),
      subtotalCents: 1000, serviceFeeCents: 0, totalCents: 1000, refundPercent: 100, serviceFeeRefundable: false, paidAt: new Date(),
    })),
  });
  const items = orders.map((o) => ({ id: randomUUID(), orderId: o.id, ticketTypeId: ttId, quantity: 1, unitPriceCents: 1000 }));
  await db.orderItem.createMany({ data: items });
  await db.payment.createMany({ data: orders.map((o) => ({ orderId: o.id, providerPaymentId: `pay_bulk${randomBytes(8).toString('hex')}`, amountCents: 1000, currency: 'EUR', status: 'SUCCEEDED' as const })) });
  await db.ticket.createMany({ data: items.map((it) => ({ orderItemId: it.id, seq: 1, eventId, publicId: randomBytes(16).toString('base64url') })) });
  await db.ticketType.update({ where: { id: ttId }, data: { sold: n } });
}

describe('annulation d’événement asynchrone (B7.1 H1)', () => {
  it('1 000 commandes payées : statut CANCELLED immédiat, traitement par lots, tout remboursé, aucune 500', async () => {
    const { eventId, ticketTypeIds } = await createEvent(org, { ticketTypes: [{ name: 'A', capacity: 2000, priceCents: 1000 }], publish: true });
    await bulkPaidOrders(eventId, ticketTypeIds[0]!, 1000);
    const t0 = Date.now();
    const res = await cancelEvent(eventId).expect(200);
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(res.body).toMatchObject({ status: 'CANCELLED', cancellationPendingOrders: 1000 });
    let total = 0;
    for (let i = 0; i < 5 && total < 1000; i += 1) {
      const r = await processEventCancellations();
      expect(r.failed).toBe(0);
      total += r.processed;
    }
    expect(total).toBe(1000);
    expect(await getDb().order.count({ where: { eventId, status: 'REFUNDED' } })).toBe(1000);
    expect(await getDb().refund.count({ where: { reason: 'EVENT_CANCELLED' } })).toBe(1000);
    expect(await getDb().ticket.count({ where: { eventId, status: { not: 'CANCELLED' } } })).toBe(0);
    const view = await api().get(`/api/v1/orgs/${org.id}/events/${eventId}`).set(org.manager.auth).expect(200);
    expect(view.body.cancellationPendingOrders).toBe(0);
  }, 180_000);

  it('deux annulations en parallèle : 200 toutes les deux, un seul audit ; idempotent', async () => {
    const { eventId } = await createEvent(org, { ticketTypes: [{ name: 'A', capacity: 10, priceCents: 1000 }], publish: true });
    const [a, b] = await Promise.all([cancelEvent(eventId), cancelEvent(eventId)]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(await getDb().auditLog.count({ where: { action: 'event.cancel' } })).toBe(1);
  });

  it('refusée après le début (409) ; un brouillon est annulable', async () => {
    const started = await createEvent(org, { ticketTypes: [{ name: 'A', capacity: 10, priceCents: 1000 }], publish: true });
    const ev = await getDb().event.findUniqueOrThrow({ where: { id: started.eventId } });
    testClock.freeze(new Date(ev.startsAt.getTime() + 1));
    const res = await cancelEvent(started.eventId);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
    testClock.reset();
    const draft = await createEvent(org);
    expect((await cancelEvent(draft.eventId).expect(200)).body.status).toBe('CANCELLED');
  });

  it('pendant le traitement : plus de vente ni de scan ; self-cancel refusé (remboursement intégral en cours)', async () => {
    const buyer = await loggedInUser();
    const { eventId, ticketTypeIds } = await createEvent(org, { ticketTypes: [{ name: 'A', capacity: 10, priceCents: 1000 }], publish: true });
    const o = await order(buyer, eventId, ticketTypeIds[0]!).expect(201);
    await payCard(buyer, o.body.id as string, 1000);
    await cancelEvent(eventId).expect(200);
    const self = await api().post(`/api/v1/orders/${o.body.id as string}/cancel`).set(buyer.auth);
    expect(self.body.error.code).toBe('CANCELLATION_CLOSED');
    expect((await order(buyer, eventId, ticketTypeIds[0]!)).body.error.code).toBe('SALES_CLOSED');
    await processEventCancellations();
    expect((await getDb().order.findUniqueOrThrow({ where: { id: o.body.id as string } })).refundAmountCents).toBe(1000);
  });

  it('offres en cours libérées (held = 0) ; acceptation après annulation ⇒ 409 ; paiement reçu après annulation ⇒ remboursé', async () => {
    const { eventId, ticketTypeIds } = await createEvent(org, { ticketTypes: [{ name: 'A', capacity: 2, priceCents: 1000 }], publish: true });
    const ttId = ticketTypeIds[0]!;
    const [h1, h2, waiting] = [await loggedInUser(), await loggedInUser(), await loggedInUser()];
    const o1 = await order(h1, eventId, ttId).expect(201);
    const o2 = await order(h2, eventId, ttId).expect(201);
    const sessionId = await openSession(o2.body.id as string, h2.auth);
    const entry = await api().post(`/api/v1/events/${eventId}/ticket-types/${ttId}/waitlist`).set(waiting.auth).send({ quantity: 1 }).expect(201);
    await getDb().order.update({ where: { id: o1.body.id as string }, data: { expiresAt: new Date(Date.now() - 60_000) } });
    await expireOrders();
    expect((await getDb().waitlistEntry.findUniqueOrThrow({ where: { id: entry.body.id as string } })).status).toBe('OFFERED');
    await cancelEvent(eventId).expect(200);
    const accept = await api().post(`/api/v1/waitlist/${entry.body.id as string}/accept`).set(waiting.auth);
    expect(accept.body.error.code).toBe('OFFER_EXPIRED');
    // Paiement de la commande en attente reçu après l'annulation : remboursé automatiquement.
    await postWebhook(paymentEvent(o2.body.id as string, 1000, { sessionId })).expect(200);
    expect(await getDb().refund.findFirstOrThrow({ where: { orderId: o2.body.id as string } })).toMatchObject({ reason: 'EVENT_CANCELLED', amountCents: 1000 });
    await processEventCancellations();
    const tt = await getDb().ticketType.findUniqueOrThrow({ where: { id: ttId } });
    expect({ sold: tt.sold, held: tt.held }).toEqual({ sold: 0, held: 0 });
  });

  it('acceptation et annulation d’événement simultanées : jamais de 500', async () => {
    for (let round = 0; round < 3; round += 1) {
      const { eventId, ticketTypeIds } = await createEvent(org, { ticketTypes: [{ name: 'A', capacity: 1, priceCents: 1000 }], publish: true });
      const [holder, waiting] = [await loggedInUser(), await loggedInUser()];
      const o = await order(holder, eventId, ticketTypeIds[0]!).expect(201);
      const entry = await api().post(`/api/v1/events/${eventId}/ticket-types/${ticketTypeIds[0]!}/waitlist`).set(waiting.auth).send({ quantity: 1 }).expect(201);
      await getDb().order.update({ where: { id: o.body.id as string }, data: { expiresAt: new Date(Date.now() - 60_000) } });
      await expireOrders();
      const [acc, can] = await Promise.all([api().post(`/api/v1/waitlist/${entry.body.id as string}/accept`).set(waiting.auth), cancelEvent(eventId)]);
      expect(acc.status).toBeLessThan(500);
      expect(can.status).toBe(200);
      await processEventCancellations();
      const tt = await getDb().ticketType.findUniqueOrThrow({ where: { id: ticketTypeIds[0]! } });
      expect({ sold: tt.sold, held: tt.held }).toEqual({ sold: 0, held: 0 });
    }
  });
});

describe('plafond par personne via la liste d’attente (B7.1 H2)', () => {
  it('inscription 4 + achat direct 4 ⇒ l’offre est écartée à la distribution (plafond 6)', async () => {
    const { eventId, ticketTypeIds } = await createEvent(org, {
      ticketTypes: [{ name: 'Complet', capacity: 1, priceCents: 1000 }, { name: 'Libre', capacity: 50, priceCents: 1000 }], publish: true,
    });
    const [full, open] = ticketTypeIds as [string, string];
    const [holder, me] = [await loggedInUser(), await loggedInUser()];
    const o = await order(holder, eventId, full).expect(201);
    await api().post(`/api/v1/events/${eventId}/ticket-types/${full}/waitlist`).set(me.auth).send({ quantity: 4 }).expect(201);
    await order(me, eventId, open, 4).expect(201);
    await api().patch(`/api/v1/orgs/${org.id}/events/${eventId}/ticket-types/${full}`).set(org.manager.auth).send({ capacity: 5 }).expect(200);
    await getDb().order.update({ where: { id: o.body.id as string }, data: { expiresAt: new Date(Date.now() - 60_000) } });
    await expireOrders();
    expect((await getDb().waitlistEntry.findFirstOrThrow({ where: { userId: me.id } })).status).toBe('EXPIRED');
  });

  it('plafond revérifié à l’acceptation ⇒ 422 LIMIT_EXCEEDED', async () => {
    const { eventId, ticketTypeIds } = await createEvent(org, { ticketTypes: [{ name: 'A', capacity: 2, priceCents: 1000 }], publish: true });
    const [h1, h2, me] = [await loggedInUser(), await loggedInUser(), await loggedInUser()];
    const o1 = await order(h1, eventId, ticketTypeIds[0]!).expect(201);
    await order(h2, eventId, ticketTypeIds[0]!).expect(201);
    const entry = await api().post(`/api/v1/events/${eventId}/ticket-types/${ticketTypeIds[0]!}/waitlist`).set(me.auth).send({ quantity: 1 }).expect(201);
    await getDb().order.update({ where: { id: o1.body.id as string }, data: { expiresAt: new Date(Date.now() - 60_000) } });
    await expireOrders();
    // Plafond abaissé entre l'offre et l'acceptation.
    await getDb().event.update({ where: { id: eventId }, data: { maxPerUser: 1, maxPerOrder: 1 } });
    await getDb().order.create({
      data: { userId: me.id, eventId, status: 'PAID', paymentMethod: 'CARD', idempotencyKey: randomUUID(), requestHash: '0'.repeat(64),
        subtotalCents: 0, serviceFeeCents: 0, totalCents: 0, refundPercent: 100, serviceFeeRefundable: false, paidAt: new Date(),
        items: { create: [{ ticketTypeId: ticketTypeIds[0]!, quantity: 1, unitPriceCents: 0 }] } },
    });
    const res = await api().post(`/api/v1/waitlist/${entry.body.id as string}/accept`).set(me.auth);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('LIMIT_EXCEEDED');
  });
});

describe('fenêtre de ventes de la liste d’attente (B7.1 M6)', () => {
  it('inscription avant l’ouverture des ventes ⇒ SALES_CLOSED ; offre échue non balayée ⇒ OFFER_EXPIRED', async () => {
    const { eventId, ticketTypeIds } = await createEvent(org, { ticketTypes: [{ name: 'A', capacity: 1, priceCents: 1000 }], publish: true });
    const [holder, me] = [await loggedInUser(), await loggedInUser()];
    const o = await order(holder, eventId, ticketTypeIds[0]!).expect(201);
    const ev = await getDb().event.findUniqueOrThrow({ where: { id: eventId } });
    testClock.freeze(new Date(ev.salesStartAt.getTime() - 1));
    expect((await api().post(`/api/v1/events/${eventId}/ticket-types/${ticketTypeIds[0]!}/waitlist`).set(me.auth).send({ quantity: 1 })).body.error.code).toBe('SALES_CLOSED');
    testClock.reset();
    const entry = await api().post(`/api/v1/events/${eventId}/ticket-types/${ticketTypeIds[0]!}/waitlist`).set(me.auth).send({ quantity: 1 }).expect(201);
    await getDb().order.update({ where: { id: o.body.id as string }, data: { expiresAt: new Date(Date.now() - 60_000) } });
    await expireOrders();
    const offered = await getDb().waitlistEntry.findUniqueOrThrow({ where: { id: entry.body.id as string } });
    testClock.freeze(new Date(offered.offerExpiresAt!.getTime() + 1));
    const res = await api().post(`/api/v1/waitlist/${entry.body.id as string}/accept`).set(me.auth);
    expect(res.body.error.code).toBe('OFFER_EXPIRED');
  });
});

describe('concurrence (B7.1 tests manquants)', () => {
  it('deux libérations VRAIMENT simultanées : offres ≤ places libres, FIFO respecté', async () => {
    const { eventId, ticketTypeIds } = await createEvent(org, { ticketTypes: [{ name: 'A', capacity: 2, priceCents: 1000 }], publish: true });
    const ttId = ticketTypeIds[0]!;
    const [a, b] = [await loggedInUser(), await loggedInUser()];
    const oa = await order(a, eventId, ttId).expect(201);
    const ob = await order(b, eventId, ttId).expect(201);
    const queue = [];
    for (let i = 0; i < 4; i += 1) {
      const u = await loggedInUser();
      queue.push(u);
      await api().post(`/api/v1/events/${eventId}/ticket-types/${ttId}/waitlist`).set(u.auth).send({ quantity: 1 }).expect(201);
    }
    await Promise.all([api().post(`/api/v1/orders/${oa.body.id as string}/cancel`).set(a.auth), api().post(`/api/v1/orders/${ob.body.id as string}/cancel`).set(b.auth)]);
    const offered = await getDb().waitlistEntry.findMany({ where: { status: 'OFFERED' }, select: { userId: true } });
    expect(offered.map((o) => o.userId).sort()).toEqual([queue[0]!.id, queue[1]!.id].sort());
    const tt = await getDb().ticketType.findUniqueOrThrow({ where: { id: ttId } });
    expect(tt.held).toBe(2);
  });

  it('double annulation simultanée d’une commande : un seul effet', async () => {
    const buyer = await loggedInUser();
    const { eventId, ticketTypeIds } = await createEvent(org, { ticketTypes: [{ name: 'A', capacity: 10, priceCents: 1000 }], publish: true });
    const o = await order(buyer, eventId, ticketTypeIds[0]!, 2).expect(201);
    await payCard(buyer, o.body.id as string, 2000);
    const results = await Promise.all([1, 2, 3].map(() => api().post(`/api/v1/orders/${o.body.id as string}/cancel`).set(buyer.auth)));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(2);
    expect(await getDb().refund.count({ where: { orderId: o.body.id as string } })).toBe(1);
    expect((await getDb().ticketType.findUniqueOrThrow({ where: { id: ticketTypeIds[0]! } })).sold).toBe(0);
  });

  it('annulation simultanée à un scan : soit annulée sans scan, soit scannée sans annulation', async () => {
    for (let i = 0; i < 3; i += 1) {
      const buyer = await loggedInUser();
      const { eventId, ticketTypeIds } = await createEvent(org, { ticketTypes: [{ name: 'A', capacity: 10, priceCents: 1000 }], publish: true });
      const o = await order(buyer, eventId, ticketTypeIds[0]!).expect(201);
      await payCard(buyer, o.body.id as string, 1000);
      const ticket = ((await api().get('/api/v1/me/tickets').set(buyer.auth)).body.items as { qrPayload: string }[])[0]!;
      const [cancel, scan] = await Promise.all([
        api().post(`/api/v1/orders/${o.body.id as string}/cancel`).set(buyer.auth),
        api().post(`/api/v1/orgs/${org.id}/events/${eventId}/checkin/scan`).set(org.scanner.auth).send({ qrPayload: ticket.qrPayload, deviceId: randomUUID(), scanId: randomUUID() }),
      ]);
      const final = await getDb().order.findUniqueOrThrow({ where: { id: o.body.id as string } });
      if (scan.body.result === 'OK') {
        expect(cancel.status).toBe(409);
        expect(final.status).toBe('PAID');
      } else {
        expect(cancel.status).toBe(200);
        expect(scan.body.result).toBe('CANCELLED');
        expect(final.status).toBe('REFUNDED');
      }
    }
  });
});

describe('export et mails (B7.1 M3 / M4 / M5 / B1 / M7)', () => {
  it('CSV : \\n et espaces de tête neutralisés', () => {
    expect(csvCell('\n=1')).toBe(`"'\n=1"`);
    expect(csvCell('  =SUM(A1)')).toBe("'  =SUM(A1)");
    expect(csvCell(' -2')).toBe("' -2");
    expect(csvCell('Jean - Paul')).toBe('Jean - Paul');
  });

  it('export d’un très gros événement (2 000 billets) complet ; coupure client sans blocage', async () => {
    const { eventId, ticketTypeIds } = await createEvent(org, { ticketTypes: [{ name: 'A', capacity: 3000, priceCents: 1000 }], publish: true });
    await bulkPaidOrders(eventId, ticketTypeIds[0]!, 2000);
    const res = await api().get(`/api/v1/orgs/${org.id}/events/${eventId}/attendees.csv`).set(org.manager.auth).buffer(true).parse((r, cb) => {
      let data = '';
      r.setEncoding('utf8');
      r.on('data', (c: string) => { data += c; });
      r.on('end', () => { cb(null, data); });
    }).expect(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect((res.body as string).split('\r\n').filter((l) => l.length > 0)).toHaveLength(2001);
    // Coupure du client au premier octet : le serveur s'arrête proprement et reste disponible.
    const server = createApp({ rateLimitMultiplier: 1000 }).listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    const { port } = server.address() as AddressInfo;
    await new Promise<void>((resolve) => {
      const req = httpRequest({ host: '127.0.0.1', port, path: `/api/v1/orgs/${org.id}/events/${eventId}/attendees.csv`, headers: org.manager.auth }, (r) => {
        r.once('data', () => { req.destroy(); resolve(); });
      });
      req.on('error', () => { resolve(); });
      req.end();
    });
    await new Promise((r) => setTimeout(r, 300));
    server.close();
    await api().get(`/api/v1/orgs/${org.id}/events/${eventId}/stats`).set(org.manager.auth).expect(200);
  }, 120_000);

  it('mail de remboursement d’un virement : « le collectif va vous rembourser … par virement »', () => {
    const pending = renderTemplate('orderRefunded', { displayName: 'A', eventTitle: 'E', amount: '20,00 €', reason: 'x', transferRefundPending: true });
    expect(pending.text).toContain('Le collectif va vous rembourser 20,00 € par virement');
    expect(pending.text).not.toContain('Vous êtes remboursé');
    const card = renderTemplate('eventCancelled', { displayName: 'A', eventTitle: 'E', amount: '20,00 €', reason: 'x', transferRefundPending: false });
    expect(card.text).toContain('Vous êtes remboursé(e) de 20,00 €');
  });

  it('refundAmountCents = montant réellement remboursé (plafonné au paiement)', async () => {
    const buyer = await loggedInUser();
    const { eventId, ticketTypeIds } = await createEvent(org, { ticketTypes: [{ name: 'A', capacity: 10, priceCents: 1000 }], publish: true });
    const o = await order(buyer, eventId, ticketTypeIds[0]!, 2).expect(201);
    await payCard(buyer, o.body.id as string, 2000);
    // Paiement partiellement déjà remboursé (geste commercial manuel).
    const payment = await getDb().payment.findFirstOrThrow({ where: { orderId: o.body.id as string } });
    await getDb().refund.create({ data: { orderId: o.body.id as string, paymentId: payment.id, amountCents: 500, reason: 'UNEXPECTED_PAYMENT', status: 'SUCCEEDED' } });
    const res = await api().post(`/api/v1/orders/${o.body.id as string}/cancel`).set(buyer.auth).expect(200);
    expect(res.body.refundAmountCents).toBe(1500);
  });

  it('un billet ne peut pas être émis pour une commande non payée (déclencheur)', async () => {
    const buyer = await loggedInUser();
    const { eventId, ticketTypeIds } = await createEvent(org, { ticketTypes: [{ name: 'A', capacity: 10, priceCents: 1000 }], publish: true });
    const o = await order(buyer, eventId, ticketTypeIds[0]!).expect(201);
    const item = await getDb().orderItem.findFirstOrThrow({ where: { orderId: o.body.id as string } });
    await expect(getDb().ticket.create({ data: { orderItemId: item.id, seq: 1, eventId, publicId: randomBytes(16).toString('base64url') } })).rejects.toThrow();
  });

  it('virement payé puis événement annulé : mail « remboursement à venir »', async () => {
    const buyer = await loggedInUser();
    await api().patch(`/api/v1/orgs/${org.id}/settings`).set(org.owner.auth)
      .send({ bank: { beneficiary: 'C', iban: 'FR7630006000011234567890189', bic: 'AGRIFRPP' }, currentPassword: PASSWORD }).expect(200);
    const { eventId, ticketTypeIds } = await createEvent(org, { ticketTypes: [{ name: 'A', capacity: 10, priceCents: 1000 }], publish: true });
    const o = await order(buyer, eventId, ticketTypeIds[0]!, 1, 'TRANSFER').expect(201);
    await api().post(`/api/v1/orgs/${org.id}/orders/${o.body.id as string}/confirm-transfer`).set(org.manager.auth).send({ receivedAmountCents: 1000 }).expect(200);
    await cancelEvent(eventId).expect(200);
    await processEventCancellations();
    const { decryptOutboxPayload } = await import('../../src/lib/outbox.js');
    const mail = await getDb().emailOutbox.findFirstOrThrow({ where: { to: buyer.email, template: 'eventCancelled' } });
    expect(decryptOutboxPayload(mail)['transferRefundPending']).toBe(true);
  });
});
