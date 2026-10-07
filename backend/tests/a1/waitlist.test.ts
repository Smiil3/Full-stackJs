import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../../src/lib/db.js';
import { testClock } from '../../src/lib/clock.js';
import { expireOrders } from '../../src/jobs/expireOrders.js';
import { expireWaitlistOffers } from '../../src/modules/waitlist/service.js';
import { MAX_EXPIRED_OFFERS_PER_EVENT } from '../../src/config/waitlist.js';
import { api, loggedInUser, type LoggedIn } from '../helpers.js';
import { createEvent, orgWithStaff, type OrgFixture } from '../fixtures.js';

let org: OrgFixture;

beforeEach(async () => {
  org = await orgWithStaff('collectif-a1-wl');
});
afterEach(() => {
  testClock.reset();
});

const order = (u: LoggedIn, eventId: string, ttId: string) =>
  api().post('/api/v1/orders').set(u.auth).set('Idempotency-Key', randomUUID()).send({ eventId, paymentMethod: 'CARD', items: [{ ticketTypeId: ttId, quantity: 1 }] });
const join = (u: LoggedIn, eventId: string, ttId: string) =>
  api().post(`/api/v1/events/${eventId}/ticket-types/${ttId}/waitlist`).set(u.auth).send({ quantity: 1 });

async function releaseOrder(orderId: string) {
  await getDb().order.update({ where: { id: orderId }, data: { expiresAt: new Date(Date.now() - 60_000) } });
  await expireOrders();
}

describe('anti-gel de la liste d’attente (M2, contrat 1.17 §6)', () => {
  it('durée d’offre bornée à 15–360 min (collectif et événement)', async () => {
    await api().patch(`/api/v1/orgs/${org.id}/settings`).set(org.owner.auth).send({ waitlistOfferMinutes: 361 }).expect(400);
    await api().patch(`/api/v1/orgs/${org.id}/settings`).set(org.owner.auth).send({ waitlistOfferMinutes: 360 }).expect(200);
    const { eventId } = await createEvent(org, { ticketTypes: [{ name: 'A', capacity: 1, priceCents: 1000 }] });
    await api().patch(`/api/v1/orgs/${org.id}/events/${eventId}`).set(org.manager.auth).send({ overrides: { waitlistOfferMinutes: 361 } }).expect(400);
  });

  it(`${MAX_EXPIRED_OFFERS_PER_EVENT}e offre expirée sur l’événement ⇒ autres inscriptions EXPIRED, réinscription 409 CONFLICT`, async () => {
    const { eventId, ticketTypeIds } = await createEvent(org, {
      ticketTypes: [{ name: 'T1', capacity: 1, priceCents: 1000 }, { name: 'T2', capacity: 1, priceCents: 1000 }], publish: true,
    });
    const [t1, t2] = ticketTypeIds as [string, string];
    const holder1 = (await order(await loggedInUser(), eventId, t1).expect(201)).body.id as string;
    await order(await loggedInUser(), eventId, t2).expect(201);
    const squatter = await loggedInUser();
    await join(squatter, eventId, t1).expect(201);
    await join(squatter, eventId, t2).expect(201);
    // Une première offre déjà laissée expirer sur cet événement.
    await getDb().waitlistEntry.create({ data: { ticketTypeId: t1, eventId, userId: squatter.id, quantity: 1, status: 'EXPIRED', offerExpired: true, createdAt: new Date(Date.now() - 3600_000) } });

    await releaseOrder(holder1);
    const offered = await getDb().waitlistEntry.findFirstOrThrow({ where: { userId: squatter.id, ticketTypeId: t1, status: 'OFFERED' } });
    testClock.freeze(new Date(offered.offerExpiresAt!.getTime() + 1));
    expect(await expireWaitlistOffers()).toMatchObject({ expired: 1, excluded: 1 });

    const entries = await getDb().waitlistEntry.findMany({ where: { userId: squatter.id }, orderBy: { createdAt: 'asc' } });
    expect(entries.every((e) => e.status === 'EXPIRED')).toBe(true);
    expect(entries.filter((e) => e.offerExpired)).toHaveLength(MAX_EXPIRED_OFFERS_PER_EVENT);
    const again = await join(squatter, eventId, t1);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('CONFLICT');
    // La place libérée revient au public.
    const tt = await getDb().ticketType.findUniqueOrThrow({ where: { id: t1 } });
    expect(tt.capacity - tt.sold - tt.held).toBe(1);
  });

  it('une seule offre expirée : la réinscription reste possible', async () => {
    const { eventId, ticketTypeIds } = await createEvent(org, { ticketTypes: [{ name: 'T', capacity: 1, priceCents: 1000 }], publish: true });
    const tt = ticketTypeIds[0]!;
    const holder = (await order(await loggedInUser(), eventId, tt).expect(201)).body.id as string;
    const late = await loggedInUser();
    await join(late, eventId, tt).expect(201);
    await releaseOrder(holder);
    const offered = await getDb().waitlistEntry.findFirstOrThrow({ where: { userId: late.id, status: 'OFFERED' } });
    testClock.freeze(new Date(offered.offerExpiresAt!.getTime() + 1));
    expect(await expireWaitlistOffers()).toMatchObject({ expired: 1, excluded: 0 });
    testClock.reset();
    await order(await loggedInUser(), eventId, tt).expect(201); // complet de nouveau
    await join(late, eventId, tt).expect(201);
  });
});

describe('ordre des verrous de la liste d’attente (B1)', () => {
  it('départs et expirations d’offres simultanés : jamais de 500, stock cohérent', async () => {
    const { eventId, ticketTypeIds } = await createEvent(org, { ticketTypes: [{ name: 'T', capacity: 4, priceCents: 1000 }], publish: true });
    const tt = ticketTypeIds[0]!;
    const holders: string[] = [];
    for (let i = 0; i < 4; i += 1) holders.push((await order(await loggedInUser(), eventId, tt).expect(201)).body.id as string);
    const waiting: LoggedIn[] = [];
    for (let i = 0; i < 8; i += 1) {
      const u = await loggedInUser();
      await join(u, eventId, tt).expect(201);
      waiting.push(u);
    }
    for (const h of holders.slice(0, 2)) await releaseOrder(h);
    const entries = await getDb().waitlistEntry.findMany({ where: { eventId, status: { in: ['WAITING', 'OFFERED'] } } });
    await getDb().waitlistEntry.updateMany({ where: { eventId, status: 'OFFERED' }, data: { offerExpiresAt: new Date(Date.now() - 1000) } });
    const leaves = entries.map((e) => {
      const u = waiting.find((w) => w.id === e.userId)!;
      return api().delete(`/api/v1/waitlist/${e.id}`).set(u.auth);
    });
    const [results] = await Promise.all([Promise.all(leaves), expireWaitlistOffers(), expireWaitlistOffers()]);
    for (const r of results) expect([204, 409]).toContain(r.status);
    const offeredQty = await getDb().waitlistEntry.aggregate({ where: { ticketTypeId: tt, status: 'OFFERED' }, _sum: { quantity: true } });
    const pendingQty = await getDb().orderItem.aggregate({ where: { ticketTypeId: tt, order: { status: 'PENDING_PAYMENT' } }, _sum: { quantity: true } });
    const t = await getDb().ticketType.findUniqueOrThrow({ where: { id: tt } });
    expect(t.held).toBe((offeredQty._sum.quantity ?? 0) + (pendingQty._sum.quantity ?? 0));
  });
});

describe('offre gratuite (INFO audit)', () => {
  it('confirmation impossible (stock incohérent) ⇒ 409, offre non convertie, aucune commande', async () => {
    const { eventId, ticketTypeIds } = await createEvent(org, { ticketTypes: [{ name: 'Gratuit', capacity: 1, priceCents: 0 }], publish: true });
    const tt = ticketTypeIds[0]!;
    const holder = await loggedInUser();
    const held = (await order(holder, eventId, tt).expect(201)).body;
    expect(held.status).toBe('PAID');
    const fan = await loggedInUser();
    await join(fan, eventId, tt).expect(201);
    await api().post(`/api/v1/orders/${held.id as string}/cancel`).set(holder.auth).expect(200);
    const entry = await getDb().waitlistEntry.findFirstOrThrow({ where: { userId: fan.id, status: 'OFFERED' } });
    await getDb().ticketType.update({ where: { id: tt }, data: { held: 0 } });
    const res = await api().post(`/api/v1/waitlist/${entry.id}/accept`).set(fan.auth);
    expect(res.status).toBe(409);
    expect((await getDb().waitlistEntry.findUniqueOrThrow({ where: { id: entry.id } })).status).toBe('OFFERED');
    expect(await getDb().order.count({ where: { userId: fan.id } })).toBe(0);
  });
});
