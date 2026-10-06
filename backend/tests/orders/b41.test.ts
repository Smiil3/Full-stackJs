import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import supertest from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../../src/lib/db.js';
import { createApp } from '../../src/app.js';
import { expireOrders, MAX_EXPIRE_FAILURES } from '../../src/jobs/expireOrders.js';
import { referenceGenerator, requestHash } from '../../src/modules/orders/service.js';
import { isTransientTxError, withTxRetry } from '../../src/lib/txRetry.js';
import { transferReference } from '../../src/lib/crypto.js';
import { AppError } from '../../src/lib/errors.js';
import { PASSWORD, api, bearerFor, createUser, loggedInUser, type LoggedIn } from '../helpers.js';
import { createEvent, orgWithStaff, type OrgFixture } from '../fixtures.js';
import { paymentEvent, postWebhook } from '../psp.js';

let org: OrgFixture;
let buyer: LoggedIn;

beforeEach(async () => {
  org = await orgWithStaff('collectif-b41');
  buyer = await loggedInUser({ email: 'acheteur-b41@test.fr' });
});
afterEach(() => {
  referenceGenerator.next = transferReference;
});

const order = (auth: { Authorization: string }, body: Record<string, unknown>, key: string = randomUUID()) =>
  api().post('/api/v1/orders').set(auth).set('Idempotency-Key', key).send(body);

describe('expiration robuste (B4.1 H1 / M5)', () => {
  it('une commande incohérente au milieu de 5 n’empêche pas les 4 autres d’expirer', async () => {
    const { eventId, ticketTypeIds } = await createEvent(org, {
      ticketTypes: [{ name: 'A', capacity: 50, priceCents: 1000 }, { name: 'Poison', capacity: 50, priceCents: 1000 }], publish: true,
    });
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const u = await createUser();
      const tt = i === 2 ? ticketTypeIds[1]! : ticketTypeIds[0]!;
      const res = await order(await bearerFor(u.id), { eventId, paymentMethod: 'CARD', items: [{ ticketTypeId: tt, quantity: 1 }] }).expect(201);
      ids.push(res.body.id as string);
    }
    // Échéances dans l'ordre ; la 3e est « poison » : ses places bloquées ont disparu (incohérence).
    for (const [i, id] of ids.entries()) {
      await getDb().order.update({ where: { id }, data: { expiresAt: new Date(Date.now() - 60_000 + i * 1000) } });
    }
    await getDb().ticketType.update({ where: { id: ticketTypeIds[1]! }, data: { held: 0 } });
    const result = await expireOrders();
    expect(result).toMatchObject({ expired: 4, failed: 1 });
    const statuses = await getDb().order.findMany({ where: { id: { in: ids } }, select: { id: true, status: true, expireFailures: true } });
    const poison = statuses.find((o) => o.id === ids[2])!;
    expect(poison).toMatchObject({ status: 'PENDING_PAYMENT', expireFailures: 1 });
    expect(statuses.filter((o) => o.status === 'EXPIRED')).toHaveLength(4);
    // Après N échecs, la commande est écartée : le worker ne la reprend plus.
    await getDb().order.update({ where: { id: ids[2]! }, data: { expireFailures: MAX_EXPIRE_FAILURES } });
    expect(await expireOrders()).toMatchObject({ expired: 0, failed: 0 });
  });

  it('l’échéance est comparée à l’horloge de la base', async () => {
    const { eventId, ticketTypeIds } = await createEvent(org, { ticketTypes: [{ name: 'A', capacity: 5, priceCents: 1000 }], publish: true });
    const res = await order(buyer.auth, { eventId, paymentMethod: 'CARD', items: [{ ticketTypeId: ticketTypeIds[0]!, quantity: 1 }] }).expect(201);
    const rows = await getDb().$queryRaw<{ dbNow: Date }[]>`SELECT now() AS "dbNow"`;
    const dbNow: Date = rows[0]!.dbNow;
    await getDb().order.update({ where: { id: res.body.id as string }, data: { expiresAt: new Date(dbNow.getTime() + 60_000) } });
    expect((await expireOrders()).expired).toBe(0);
    await getDb().order.update({ where: { id: res.body.id as string }, data: { expiresAt: new Date(dbNow.getTime() - 1) } });
    expect((await expireOrders()).expired).toBe(1);
  });

  it('commande par virement expirée : places libérées', async () => {
    await api().patch(`/api/v1/orgs/${org.id}/settings`).set(org.owner.auth)
      .send({ bank: { beneficiary: 'C', iban: 'FR7630006000011234567890189', bic: 'AGRIFRPP' }, currentPassword: PASSWORD }).expect(200);
    const { eventId, ticketTypeIds } = await createEvent(org, { ticketTypes: [{ name: 'A', capacity: 5, priceCents: 1000 }], publish: true });
    const res = await order(buyer.auth, { eventId, paymentMethod: 'TRANSFER', items: [{ ticketTypeId: ticketTypeIds[0]!, quantity: 2 }] }).expect(201);
    await getDb().order.update({ where: { id: res.body.id as string }, data: { expiresAt: new Date(Date.now() - 60_000) } });
    expect((await expireOrders()).expired).toBe(1);
    expect((await getDb().order.findUniqueOrThrow({ where: { id: res.body.id as string } })).status).toBe('EXPIRED');
    expect((await getDb().ticketType.findUniqueOrThrow({ where: { id: ticketTypeIds[0]! } })).held).toBe(0);
  });

  it('expiration concurrente d’un paiement : état final cohérent (payée, places vendues, billets émis une fois)', async () => {
    for (let round = 0; round < 3; round += 1) {
      const { eventId, ticketTypeIds } = await createEvent(org, { ticketTypes: [{ name: 'A', capacity: 10, priceCents: 1000 }], publish: true });
      const u = await createUser();
      const res = await order(await bearerFor(u.id), { eventId, paymentMethod: 'CARD', items: [{ ticketTypeId: ticketTypeIds[0]!, quantity: 2 }] }).expect(201);
      const orderId = res.body.id as string;
      await getDb().order.update({ where: { id: orderId }, data: { expiresAt: new Date(Date.now() - 60_000) } });
      const [, hook] = await Promise.all([expireOrders(), postWebhook(paymentEvent(orderId, res.body.totalCents as number))]);
      expect(hook.status).toBe(200);
      const final = await getDb().order.findUniqueOrThrow({ where: { id: orderId } });
      const tt = await getDb().ticketType.findUniqueOrThrow({ where: { id: ticketTypeIds[0]! } });
      expect(final.status).toBe('PAID');
      expect({ sold: tt.sold, held: tt.held }).toEqual({ sold: 2, held: 0 });
      expect(await getDb().ticket.count({ where: { orderItem: { orderId } } })).toBe(2);
    }
  });
});

describe('réservation face à une annulation concurrente (B4.1 H2)', () => {
  it('l’événement est annulé pendant la réservation ⇒ SALES_CLOSED, aucune place bloquée', async () => {
    const { eventId, ticketTypeIds } = await createEvent(org, { ticketTypes: [{ name: 'A', capacity: 10, priceCents: 1000 }], publish: true });
    let release!: () => void;
    const locked = new Promise<void>((resolve) => { release = resolve; });
    // Annulation simulée : verrou exclusif sur l'événement, passage à CANCELLED, validation différée.
    const cancel = getDb().$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "events" WHERE "id" = ${eventId}::uuid FOR UPDATE`;
      await tx.event.update({ where: { id: eventId }, data: { status: 'CANCELLED' } });
      release();
      await sleep(300);
    });
    await locked;
    const res = await order(buyer.auth, { eventId, paymentMethod: 'CARD', items: [{ ticketTypeId: ticketTypeIds[0]!, quantity: 1 }] });
    await cancel;
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('SALES_CLOSED');
    expect((await getDb().ticketType.findUniqueOrThrow({ where: { id: ticketTypeIds[0]! } })).held).toBe(0);
  });

  it('report validé pendant la réservation ⇒ la commande est calculée sur les nouvelles dates', async () => {
    const { eventId, ticketTypeIds } = await createEvent(org, { ticketTypes: [{ name: 'A', capacity: 10, priceCents: 1000 }], publish: true });
    const ev = await getDb().event.findUniqueOrThrow({ where: { id: eventId } });
    const newStart = new Date(ev.startsAt.getTime() + 7 * 86400_000);
    let release!: () => void;
    const locked = new Promise<void>((resolve) => { release = resolve; });
    const reschedule = getDb().$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "events" WHERE "id" = ${eventId}::uuid FOR UPDATE`;
      await tx.event.update({ where: { id: eventId }, data: { startsAt: newStart, endsAt: new Date(ev.endsAt.getTime() + 7 * 86400_000) } });
      release();
      await sleep(300);
    });
    await locked;
    const res = await order(buyer.auth, { eventId, paymentMethod: 'CARD', items: [{ ticketTypeId: ticketTypeIds[0]!, quantity: 1 }] }).expect(201);
    await reschedule;
    expect(res.body.eventStartsAt).toBe(newStart.toISOString());
    expect(new Date(res.body.cancellableUntil as string).getTime()).toBe(newStart.getTime() - 48 * 3600_000);
  });
});

describe('concurrence et nouveaux essais (B4.1 M1)', () => {
  it('commandes multi-types en parallèle, items dans des ordres opposés ⇒ jamais de 500', async () => {
    const { eventId, ticketTypeIds } = await createEvent(org, {
      ticketTypes: [{ name: 'A', capacity: 30, priceCents: 1000 }, { name: 'B', capacity: 30, priceCents: 1000 }, { name: 'C', capacity: 30, priceCents: 1000 }],
      publish: true,
    });
    const users = await Promise.all(Array.from({ length: 40 }, () => createUser()));
    const results = await Promise.all(users.map(async (u, i) => {
      const items = ticketTypeIds.map((ticketTypeId) => ({ ticketTypeId, quantity: 1 }));
      return order(await bearerFor(u.id), { eventId, paymentMethod: 'CARD', items: i % 2 === 0 ? items : [...items].reverse() });
    }));
    expect(results.some((r) => r.status >= 500)).toBe(false);
    const created = results.filter((r) => r.status === 201).length;
    expect(created).toBe(30);
    for (const id of ticketTypeIds) expect((await getDb().ticketType.findUniqueOrThrow({ where: { id } })).held).toBe(30);
  });

  it('withTxRetry : rejoue sur interblocage / sérialisation puis renvoie 409', async () => {
    let calls = 0;
    const ok = await withTxRetry(() => {
      calls += 1;
      return calls < 3 ? Promise.reject(Object.assign(new Error('deadlock detected'), { code: '40P01' })) : Promise.resolve('ok');
    });
    expect(ok).toBe('ok');
    expect(calls).toBe(3);
    await expect(withTxRetry(() => Promise.reject(Object.assign(new Error('x'), { code: 'P2034' })))).rejects.toMatchObject({ status: 409, code: 'CONFLICT' });
    await expect(withTxRetry(() => Promise.reject(new AppError(409, 'SOLD_OUT', 'x')))).rejects.toMatchObject({ code: 'SOLD_OUT' });
    expect(isTransientTxError({ meta: { code: '40001' } })).toBe(true);
    expect(isTransientTxError({ cause: { code: '40P01' } })).toBe(true);
    expect(isTransientTxError(new Error('autre'))).toBe(false);
  });

  it('même acheteur, 50 requêtes parallèles : plafond par personne exact, aucune erreur', async () => {
    const { eventId, ticketTypeIds } = await createEvent(org, { ticketTypes: [{ name: 'A', capacity: 100, priceCents: 1000 }], publish: true });
    const results = await Promise.all(Array.from({ length: 50 }, () =>
      order(buyer.auth, { eventId, paymentMethod: 'CARD', items: [{ ticketTypeId: ticketTypeIds[0]!, quantity: 1 }] })));
    expect(results.filter((r) => r.status === 201)).toHaveLength(6);
    expect(results.filter((r) => r.status === 422)).toHaveLength(44);
    expect((await getDb().ticketType.findUniqueOrThrow({ where: { id: ticketTypeIds[0]! } })).held).toBe(6);
  });
});

describe('idempotence et tarification (B4.1)', () => {
  it('permutation de l’ordre des items ⇒ même empreinte', () => {
    const a = { ticketTypeId: '11111111-1111-4111-8111-111111111111', quantity: 1 };
    const b = { ticketTypeId: 'aaaaaaaa-1111-4111-8111-111111111111', quantity: 2 };
    const base = { eventId: '22222222-2222-4222-8222-222222222222', paymentMethod: 'CARD' as const };
    expect(requestHash({ ...base, items: [a, b] })).toBe(requestHash({ ...base, items: [b, a] }));
    expect(requestHash({ ...base, items: [a, b] })).not.toBe(requestHash({ ...base, items: [a, { ...b, quantity: 3 }] }));
  });

  it('même clé sur deux événements ⇒ 409 IDEMPOTENCY_CONFLICT', async () => {
    const e1 = await createEvent(org, { ticketTypes: [{ name: 'A', capacity: 10, priceCents: 1000 }], publish: true });
    const e2 = await createEvent(org, { ticketTypes: [{ name: 'A', capacity: 10, priceCents: 1000 }], publish: true });
    const key = randomUUID();
    await order(buyer.auth, { eventId: e1.eventId, paymentMethod: 'CARD', items: [{ ticketTypeId: e1.ticketTypeIds[0]!, quantity: 1 }] }, key).expect(201);
    const res = await order(buyer.auth, { eventId: e2.eventId, paymentMethod: 'CARD', items: [{ ticketTypeId: e2.ticketTypeIds[0]!, quantity: 1 }] }, key);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('300 requêtes autour de earlyUntil : chaque prix correspond à l’instant de tarification', async () => {
    const earlyUntil = new Date(Date.now() + 400);
    const { eventId, ticketTypeIds } = await createEvent(org, {
      ticketTypes: [{ name: 'E', capacity: 1000, priceCents: 2500, earlyPriceCents: 1800, earlyUntil: earlyUntil.toISOString() }], publish: true,
    });
    const users = await getDb().user.createManyAndReturn({
      data: Array.from({ length: 300 }, (_, i) => ({ email: `early${i}@test.fr`, displayName: `E${i}`, passwordHash: 'x', emailVerifiedAt: new Date() })),
      select: { id: true },
    });
    const auths = await Promise.all(users.map((u) => bearerFor(u.id)));
    const results = await Promise.all(auths.map((auth) => order(auth, { eventId, paymentMethod: 'CARD', items: [{ ticketTypeId: ticketTypeIds[0]!, quantity: 1 }] })));
    expect(results.every((r) => r.status === 201)).toBe(true);
    const orders = await getDb().order.findMany({ where: { eventId }, include: { items: true } });
    for (const o of orders) {
      const expected = o.createdAt.getTime() < earlyUntil.getTime() ? 1800 : 2500;
      expect(o.items[0]!.unitPriceCents).toBe(expected);
    }
  }, 120_000);
});

describe('virement et gratuité (B4.1 M6 / B1)', () => {
  it('collision de référence de virement ⇒ nouvelle référence tirée', async () => {
    await api().patch(`/api/v1/orgs/${org.id}/settings`).set(org.owner.auth)
      .send({ bank: { beneficiary: 'C', iban: 'FR7630006000011234567890189', bic: 'AGRIFRPP' }, currentPassword: PASSWORD }).expect(200);
    const { eventId, ticketTypeIds } = await createEvent(org, { ticketTypes: [{ name: 'A', capacity: 10, priceCents: 1000 }], publish: true });
    const body = { eventId, paymentMethod: 'TRANSFER', items: [{ ticketTypeId: ticketTypeIds[0]!, quantity: 1 }] };
    referenceGenerator.next = () => 'NG-DOUBLON22';
    await order(buyer.auth, body).expect(201);
    const sequence = ['NG-DOUBLON22', 'NG-UNIQUE333'];
    referenceGenerator.next = () => sequence.shift() ?? transferReference();
    const other = await loggedInUser();
    const res = await order(other.auth, body).expect(201);
    expect(res.body.transferInstructions.reference).toBe('NG-UNIQUE333');
  });

  it('commande gratuite demandée en virement ⇒ confirmée sans instructions ni contrôle bancaire', async () => {
    const { eventId, ticketTypeIds } = await createEvent(org, { ticketTypes: [{ name: 'Libre', capacity: 10, priceCents: 0 }], publish: true });
    const res = await order(buyer.auth, { eventId, paymentMethod: 'TRANSFER', items: [{ ticketTypeId: ticketTypeIds[0]!, quantity: 1 }] }).expect(201);
    expect(res.body).toMatchObject({ status: 'PAID', totalCents: 0, transferInstructions: null });
  });
});

describe('limites de réservation (B4.1 M4)', () => {
  it('au plus 10 réservations par minute et par compte, même depuis plusieurs IP', async () => {
    const app = supertest(createApp({ rateLimitMultiplier: 1 }));
    const { eventId, ticketTypeIds } = await createEvent(org, { ticketTypes: [{ name: 'A', capacity: 100, priceCents: 1000 }], publish: true });
    const statuses: number[] = [];
    for (let i = 0; i < 11; i += 1) {
      const res = await app.post('/api/v1/orders').set(buyer.auth).set('Idempotency-Key', randomUUID())
        .send({ eventId, paymentMethod: 'CARD', items: [{ ticketTypeId: ticketTypeIds[0]!, quantity: 1 }] });
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 10).every((s) => s !== 429)).toBe(true);
    expect(statuses[10]).toBe(429);
  });
});
