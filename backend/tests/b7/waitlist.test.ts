import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../../src/lib/db.js';
import { testClock } from '../../src/lib/clock.js';
import { expireOrders } from '../../src/jobs/expireOrders.js';
import { expireWaitlistOffers } from '../../src/modules/waitlist/service.js';
import { api, bearerFor, createUser, lastMail, loggedInUser, type LoggedIn } from '../helpers.js';
import { createEvent, orgWithStaff, type OrgFixture } from '../fixtures.js';

let org: OrgFixture;

beforeEach(async () => {
  org = await orgWithStaff('collectif-wl');
});
afterEach(() => {
  testClock.reset();
});

async function soldOutEvent(capacity = 4, overrides: Record<string, unknown> = {}) {
  const { eventId, ticketTypeIds } = await createEvent(org, { ticketTypes: [{ name: 'Fosse', capacity, priceCents: 1000 }], publish: true, body: { overrides } });
  const holders: { user: LoggedIn; orderId: string }[] = [];
  for (let i = 0; i < capacity; i += 1) {
    const user = await loggedInUser();
    const res = await api().post('/api/v1/orders').set(user.auth).set('Idempotency-Key', randomUUID())
      .send({ eventId, paymentMethod: 'CARD', items: [{ ticketTypeId: ticketTypeIds[0]!, quantity: 1 }] }).expect(201);
    holders.push({ user, orderId: res.body.id as string });
  }
  return { eventId, ttId: ticketTypeIds[0]!, holders };
}

const join = (u: LoggedIn, eventId: string, ttId: string, quantity = 1) =>
  api().post(`/api/v1/events/${eventId}/ticket-types/${ttId}/waitlist`).set(u.auth).send({ quantity });

async function expireOne(orderId: string) {
  await getDb().order.update({ where: { id: orderId }, data: { expiresAt: new Date(Date.now() - 60_000) } });
  await expireOrders();
}

describe('liste d’attente', () => {
  it('inscription seulement si complet ; une seule entrée active ; plafonds', async () => {
    const { eventId, ttId } = await soldOutEvent(4);
    const a = await loggedInUser();
    const res = await join(a, eventId, ttId, 2).expect(201);
    expect(res.body).toMatchObject({ status: 'WAITING', position: 1, quantity: 2, ticketTypeName: 'Fosse' });
    const dup = await join(a, eventId, ttId, 1);
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('ALREADY_IN_WAITLIST');
    const big = await join(await loggedInUser(), eventId, ttId, 7);
    expect(big.status).toBe(422);
    const notFull = await createEvent(org, { ticketTypes: [{ name: 'Libre', capacity: 10, priceCents: 1000 }], publish: true });
    const nf = await join(a, notFull.eventId, notFull.ticketTypeIds[0]!, 1);
    expect(nf.status).toBe(409);
    expect(nf.body.error.code).toBe('NOT_SOLD_OUT');
  });

  it('liste désactivée ⇒ 409 WAITLIST_DISABLED', async () => {
    const { eventId, ttId } = await soldOutEvent(2, { waitlistEnabled: false });
    const res = await join(await loggedInUser(), eventId, ttId);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('WAITLIST_DISABLED');
  });

  it('ordre FIFO : la place libérée va au premier inscrit, avec mail ; position des suivants', async () => {
    const { eventId, ttId, holders } = await soldOutEvent(3);
    const [first, second, third] = [await loggedInUser(), await loggedInUser(), await loggedInUser()];
    await join(first, eventId, ttId).expect(201);
    await join(second, eventId, ttId).expect(201);
    await join(third, eventId, ttId).expect(201);
    await expireOne(holders[0]!.orderId);
    const list1 = await api().get('/api/v1/me/waitlist').set(first.auth).expect(200);
    expect(list1.body.items[0]).toMatchObject({ status: 'OFFERED', position: null });
    expect(list1.body.items[0].offerExpiresAt).not.toBeNull();
    expect(await lastMail(first.email, 'waitlistOffer')).not.toBeNull();
    const list2 = await api().get('/api/v1/me/waitlist').set(second.auth).expect(200);
    expect(list2.body.items[0]).toMatchObject({ status: 'WAITING', position: 1 });
    const list3 = await api().get('/api/v1/me/waitlist').set(third.auth).expect(200);
    expect(list3.body.items[0]).toMatchObject({ status: 'WAITING', position: 2 });
  });

  it('places libérées : à la liste d’attente avant le public', async () => {
    const { eventId, ttId, holders } = await soldOutEvent(2);
    const waiting = await loggedInUser();
    await join(waiting, eventId, ttId).expect(201);
    await expireOne(holders[0]!.orderId);
    // L'offre bloque la place : le public ne peut pas l'acheter.
    const pub = await api().post('/api/v1/orders').set((await loggedInUser()).auth).set('Idempotency-Key', randomUUID())
      .send({ eventId, paymentMethod: 'CARD', items: [{ ticketTypeId: ttId, quantity: 1 }] });
    expect(pub.status).toBe(409);
    expect(pub.body.error.code).toBe('SOLD_OUT');
    const catalog = await api().get(`/api/v1/events/${eventId}`).expect(200);
    expect(catalog.body.ticketTypes[0].availability).toBe('SOLD_OUT');
  });

  it('une demande trop grosse garde son rang sans bloquer les suivantes ni le public', async () => {
    const { eventId, ttId, holders } = await soldOutEvent(3);
    const big = await loggedInUser();
    const small = await loggedInUser();
    await join(big, eventId, ttId, 3).expect(201);
    await join(small, eventId, ttId, 1).expect(201);
    await expireOne(holders[0]!.orderId); // 1 place libre
    const bigView = await api().get('/api/v1/me/waitlist').set(big.auth).expect(200);
    expect(bigView.body.items[0]).toMatchObject({ status: 'WAITING', position: 1 });
    const smallView = await api().get('/api/v1/me/waitlist').set(small.auth).expect(200);
    expect(smallView.body.items[0].status).toBe('OFFERED');
    // Une 2e place se libère : personne d'autre ne tient dedans ⇒ le public peut l'acheter.
    await expireOne(holders[1]!.orderId);
    const pub = await api().post('/api/v1/orders').set((await loggedInUser()).auth).set('Idempotency-Key', randomUUID())
      .send({ eventId, paymentMethod: 'CARD', items: [{ ticketTypeId: ttId, quantity: 1 }] });
    expect(pub.status).toBe(201);
  });

  it('offre expirée ⇒ suivant ; quitter une offre ⇒ suivant', async () => {
    const { eventId, ttId, holders } = await soldOutEvent(2);
    const [a, b, c] = [await loggedInUser(), await loggedInUser(), await loggedInUser()];
    await join(a, eventId, ttId).expect(201);
    await join(b, eventId, ttId).expect(201);
    await join(c, eventId, ttId).expect(201);
    await expireOne(holders[0]!.orderId);
    await getDb().waitlistEntry.updateMany({ where: { status: 'OFFERED' }, data: { offerExpiresAt: new Date(Date.now() - 1000) } });
    expect((await expireWaitlistOffers()).expired).toBe(1);
    const viewA = await api().get('/api/v1/me/waitlist').set(a.auth).expect(200);
    expect(viewA.body.items[0].status).toBe('EXPIRED');
    const viewB = await api().get('/api/v1/me/waitlist').set(b.auth).expect(200);
    expect(viewB.body.items[0].status).toBe('OFFERED');
    await api().delete(`/api/v1/waitlist/${viewB.body.items[0].id as string}`).set(b.auth).expect(204);
    const viewC = await api().get('/api/v1/me/waitlist').set(c.auth).expect(200);
    expect(viewC.body.items[0].status).toBe('OFFERED');
    const tt = await getDb().ticketType.findUniqueOrThrow({ where: { id: ttId } });
    expect(tt.sold + tt.held).toBe(2);
  });

  it('acceptation : commande CARD en attente sur les places déjà bloquées ; offre expirée ⇒ 409 ; idempotente', async () => {
    const { eventId, ttId, holders } = await soldOutEvent(2);
    const a = await loggedInUser();
    const entry = await join(a, eventId, ttId).expect(201);
    await expireOne(holders[0]!.orderId);
    const before = await getDb().ticketType.findUniqueOrThrow({ where: { id: ttId } });
    const order = await api().post(`/api/v1/waitlist/${entry.body.id as string}/accept`).set(a.auth).expect(201);
    expect(order.body).toMatchObject({ status: 'PENDING_PAYMENT', paymentMethod: 'CARD', totalCents: 1000, items: [{ quantity: 1 }] });
    const after = await getDb().ticketType.findUniqueOrThrow({ where: { id: ttId } });
    expect(after.held).toBe(before.held); // aucune nouvelle réservation
    const again = await api().post(`/api/v1/waitlist/${entry.body.id as string}/accept`).set(a.auth).expect(201);
    expect(again.body.id).toBe(order.body.id);
    // Autre acheteur, autre entrée : offre expirée.
    const b = await loggedInUser();
    const eb = await join(b, eventId, ttId).expect(201);
    await expireOne(holders[1]!.orderId);
    await getDb().waitlistEntry.update({ where: { id: eb.body.id as string }, data: { offerExpiresAt: new Date(Date.now() - 1000) } });
    const late = await api().post(`/api/v1/waitlist/${eb.body.id as string}/accept`).set(b.auth);
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe('OFFER_EXPIRED');
    // L'entrée d'autrui est introuvable.
    await api().post(`/api/v1/waitlist/${entry.body.id as string}/accept`).set(b.auth).expect(404);
  });

  it('hausse de capacité : nouvelles places d’abord à la liste d’attente', async () => {
    const { eventId, ttId } = await soldOutEvent(2);
    const a = await loggedInUser();
    await join(a, eventId, ttId).expect(201);
    await api().patch(`/api/v1/orgs/${org.id}/events/${eventId}/ticket-types/${ttId}`).set(org.manager.auth).send({ capacity: 3 }).expect(200);
    const view = await api().get('/api/v1/me/waitlist').set(a.auth).expect(200);
    expect(view.body.items[0].status).toBe('OFFERED');
  });

  it('concurrence : 20 personnes en attente, 5 places libérées d’un coup ⇒ exactement 5 offres, FIFO', async () => {
    const { eventId, ttId, holders } = await soldOutEvent(5);
    const users = [];
    for (let i = 0; i < 20; i += 1) {
      const u = await createUser();
      users.push(u);
      await api().post(`/api/v1/events/${eventId}/ticket-types/${ttId}/waitlist`).set(await bearerFor(u.id)).send({ quantity: 1 }).expect(201);
    }
    await getDb().order.updateMany({ where: { id: { in: holders.map((h) => h.orderId) } }, data: { expiresAt: new Date(Date.now() - 60_000) } });
    await Promise.all([expireOrders(), expireOrders()]);
    const offered = await getDb().waitlistEntry.findMany({ where: { status: 'OFFERED' }, select: { userId: true } });
    expect(offered.map((o) => o.userId).sort()).toEqual(users.slice(0, 5).map((u) => u.id).sort());
    const tt = await getDb().ticketType.findUniqueOrThrow({ where: { id: ttId } });
    expect({ sold: tt.sold, held: tt.held }).toEqual({ sold: 0, held: 5 });
  });
});
