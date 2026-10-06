import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../../src/lib/db.js';
import { testClock } from '../../src/lib/clock.js';
import { expireOrders } from '../../src/jobs/expireOrders.js';
import { decryptOutboxPayload } from '../../src/lib/outbox.js';
import { PASSWORD, api, bearerFor, createUser, loggedInUser, type LoggedIn } from '../helpers.js';
import { createEvent, orgWithStaff, setStock, type OrgFixture } from '../fixtures.js';

let org: OrgFixture;
let buyer: LoggedIn;

beforeEach(async () => {
  org = await orgWithStaff('collectif-orders');
  buyer = await loggedInUser({ email: 'acheteur@test.fr' });
});
afterEach(() => {
  testClock.reset();
});

function order(auth: { Authorization: string }, body: Record<string, unknown>, key: string = randomUUID()) {
  return api().post('/api/v1/orders').set(auth).set('Idempotency-Key', key).send(body);
}

async function publishedEvent(ticketTypes: Record<string, unknown>[], body: Record<string, unknown> = {}) {
  return createEvent(org, { ticketTypes, publish: true, body });
}

describe('réservation — zéro survente', () => {
  it('300 requêtes simultanées sur 10 places ⇒ exactement 10 places réservées, 0 survente', async () => {
    const { eventId, ticketTypeIds } = await publishedEvent([{ name: 'Balcon', capacity: 10, priceCents: 2000 }]);
    const ttId = ticketTypeIds[0]!;
    const users = await getDb().user.createManyAndReturn({
      data: Array.from({ length: 300 }, (_, i) => ({ email: `foule${i}@test.fr`, displayName: `F${i}`, passwordHash: 'x', emailVerifiedAt: new Date() })),
      select: { id: true },
    });
    const auths = await Promise.all(users.map((u) => bearerFor(u.id)));
    const results = await Promise.all(
      auths.map((auth) => order(auth, { eventId, paymentMethod: 'CARD', items: [{ ticketTypeId: ttId, quantity: 1 }] })),
    );
    const created = results.filter((r) => r.status === 201);
    const soldOut = results.filter((r) => r.status === 409 && r.body.error.code === 'SOLD_OUT');
    expect(created).toHaveLength(10);
    expect(soldOut).toHaveLength(290);
    expect(results.every((r) => r.status === 201 || r.status === 409)).toBe(true);
    const tt = await getDb().ticketType.findUniqueOrThrow({ where: { id: ttId } });
    expect(tt.held + tt.sold).toBe(10);
    expect(await getDb().order.count({ where: { eventId } })).toBe(10);
  }, 120_000);

  it('commande multi-types : tout ou rien (aucune place bloquée si un type est complet)', async () => {
    const { eventId, ticketTypeIds } = await publishedEvent([
      { name: 'A', capacity: 10, priceCents: 1000 }, { name: 'B', capacity: 2, priceCents: 1000 },
    ]);
    const res = await order(buyer.auth, { eventId, paymentMethod: 'CARD', items: [{ ticketTypeId: ticketTypeIds[0]!, quantity: 2 }, { ticketTypeId: ticketTypeIds[1]!, quantity: 3 }] });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: 'SOLD_OUT', details: { ticketTypeId: ticketTypeIds[1] } });
    const a = await getDb().ticketType.findUniqueOrThrow({ where: { id: ticketTypeIds[0]! } });
    expect(a.held).toBe(0);
  });

  it('places réservées aux personnes en liste d’attente : le public reçoit SOLD_OUT', async () => {
    const { eventId, ticketTypeIds } = await publishedEvent([{ name: 'A', capacity: 10, priceCents: 1000 }]);
    const waiting = await createUser();
    await getDb().waitlistEntry.create({ data: { ticketTypeId: ticketTypeIds[0]!, eventId, userId: waiting.id, quantity: 4 } });
    const res = await order(buyer.auth, { eventId, paymentMethod: 'CARD', items: [{ ticketTypeId: ticketTypeIds[0]!, quantity: 1 }] });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('SOLD_OUT');
  });
});

describe('prix calculés par le serveur', () => {
  it('commande carte : prix figés, frais en points de base, échéance carte, réponse contractuelle', async () => {
    await api().patch(`/api/v1/orgs/${org.id}/settings`).set(org.owner.auth).send({ serviceFeeFixedCents: 50, serviceFeeBasisPoints: 250, cardHoldMinutes: 20 }).expect(200);
    const { eventId, ticketTypeIds } = await publishedEvent([{ name: 'Fosse', capacity: 100, priceCents: 1700 }]);
    const res = await order(buyer.auth, { eventId, paymentMethod: 'CARD', items: [{ ticketTypeId: ticketTypeIds[0]!, quantity: 3 }] });
    expect(res.status).toBe(201);
    // 3 × 17 € = 51 € ; frais = 0,50 € + round_half_up(5100 × 250 / 10000 = 127,5) = 50 + 128.
    expect(res.body).toMatchObject({
      status: 'PENDING_PAYMENT', paymentMethod: 'CARD', subtotalCents: 5100, serviceFeeCents: 178, totalCents: 5278, currency: 'EUR',
      items: [{ ticketTypeId: ticketTypeIds[0], name: 'Fosse', quantity: 3, unitPriceCents: 1700 }],
      refundPercent: 100, refundAmountCents: null, refundPreviewCents: 0, transferInstructions: null, paidAt: null,
    });
    const expires = new Date(res.body.expiresAt as string).getTime();
    expect(expires - Date.now()).toBeGreaterThan(19 * 60_000);
    expect(expires - Date.now()).toBeLessThanOrEqual(20 * 60_000);
    const tt = await getDb().ticketType.findUniqueOrThrow({ where: { id: ticketTypeIds[0]! } });
    expect(tt.held).toBe(3);
  });

  it('un prix envoyé par le client est refusé (champ inconnu)', async () => {
    const { eventId, ticketTypeIds } = await publishedEvent([{ name: 'Fosse', capacity: 100, priceCents: 1700 }]);
    const res = await order(buyer.auth, { eventId, paymentMethod: 'CARD', totalCents: 1, items: [{ ticketTypeId: ticketTypeIds[0]!, quantity: 1, unitPriceCents: 1 }] });
    expect(res.status).toBe(400);
  });

  it('bornes du tarif early au milliseconde près', async () => {
    const earlyUntil = new Date(Date.now() + 3600_000);
    const { eventId, ticketTypeIds } = await publishedEvent([{ name: 'E', capacity: 100, priceCents: 2500, earlyPriceCents: 1800, earlyUntil: earlyUntil.toISOString() }]);
    const body = { eventId, paymentMethod: 'CARD', items: [{ ticketTypeId: ticketTypeIds[0]!, quantity: 1 }] };
    testClock.freeze(new Date(earlyUntil.getTime() - 1));
    const before = await order(buyer.auth, body);
    expect(before.body.items[0].unitPriceCents).toBe(1800);
    testClock.freeze(earlyUntil);
    const at = await order(buyer.auth, body);
    expect(at.body.items[0].unitPriceCents).toBe(2500);
    testClock.freeze(new Date(earlyUntil.getTime() + 1));
    const after = await order(buyer.auth, body);
    expect(after.body.items[0].unitPriceCents).toBe(2500);
  });
});

describe('plafonds', () => {
  it('plafond par commande ⇒ 422 LIMIT_EXCEEDED', async () => {
    const { eventId, ticketTypeIds } = await publishedEvent([{ name: 'A', capacity: 100, priceCents: 1000 }, { name: 'B', capacity: 100, priceCents: 1000 }]);
    const res = await order(buyer.auth, { eventId, paymentMethod: 'CARD', items: [{ ticketTypeId: ticketTypeIds[0]!, quantity: 4 }, { ticketTypeId: ticketTypeIds[1]!, quantity: 3 }] });
    expect(res.status).toBe(422);
    expect(res.body.error).toMatchObject({ code: 'LIMIT_EXCEEDED', details: { max: 6, alreadyOwned: 0 } });
  });

  it('plafond par personne cumulé sur les commandes actives (les expirées ne comptent pas)', async () => {
    const { eventId, ticketTypeIds } = await publishedEvent([{ name: 'A', capacity: 100, priceCents: 1000 }]);
    const item = (quantity: number) => ({ eventId, paymentMethod: 'CARD', items: [{ ticketTypeId: ticketTypeIds[0]!, quantity }] });
    const first = await order(buyer.auth, item(4));
    expect(first.status).toBe(201);
    const over = await order(buyer.auth, item(3));
    expect(over.status).toBe(422);
    expect(over.body.error.details).toEqual({ max: 6, alreadyOwned: 4 });
    await order(buyer.auth, item(2)).expect(201);
    // La première commande expire : ses places ne comptent plus.
    await getDb().order.update({ where: { id: first.body.id as string }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await expireOrders();
    await order(buyer.auth, item(4)).expect(201);
  });

  it('plafond par personne exact même avec des commandes parallèles du même acheteur', async () => {
    const { eventId, ticketTypeIds } = await publishedEvent([{ name: 'A', capacity: 100, priceCents: 1000 }]);
    const results = await Promise.all(Array.from({ length: 10 }, () =>
      order(buyer.auth, { eventId, paymentMethod: 'CARD', items: [{ ticketTypeId: ticketTypeIds[0]!, quantity: 2 }] })));
    expect(results.filter((r) => r.status === 201)).toHaveLength(3);
    const tt = await getDb().ticketType.findUniqueOrThrow({ where: { id: ticketTypeIds[0]! } });
    expect(tt.held).toBe(6);
  });

  it('places gratuites : PAID immédiat, billets émis, mais mêmes plafonds — impossible d’aspirer le stock', async () => {
    const { eventId, ticketTypeIds } = await publishedEvent([{ name: 'Gratuit', capacity: 100, priceCents: 0 }], { overrides: { maxPerOrder: 2, maxPerUser: 4 } });
    const body = { eventId, paymentMethod: 'CARD', items: [{ ticketTypeId: ticketTypeIds[0]!, quantity: 2 }] };
    const first = await order(buyer.auth, body);
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ status: 'PAID', totalCents: 0, serviceFeeCents: 0, expiresAt: null });
    expect(await getDb().ticket.count({ where: { eventId } })).toBe(2);
    await order(buyer.auth, body).expect(201);
    const third = await order(buyer.auth, body);
    expect(third.status).toBe(422);
    expect(third.body.error.details).toEqual({ max: 4, alreadyOwned: 4 });
    await order(buyer.auth, { ...body, items: [{ ticketTypeId: ticketTypeIds[0]!, quantity: 3 }] }).expect(422);
    // Même en parallèle.
    const other = await loggedInUser();
    const burst = await Promise.all(Array.from({ length: 8 }, () => order(other.auth, body)));
    expect(burst.filter((r) => r.status === 201)).toHaveLength(2);
    const tt = await getDb().ticketType.findUniqueOrThrow({ where: { id: ticketTypeIds[0]! } });
    expect(tt.sold).toBe(8);
    expect(tt.held).toBe(0);
  });
});

describe('règles de vente', () => {
  it('email non vérifié ⇒ 403 ; ventes fermées / événement brouillon ⇒ 409 / 404', async () => {
    const { eventId, ticketTypeIds } = await publishedEvent([{ name: 'A', capacity: 10, priceCents: 1000 }]);
    const body = { eventId, paymentMethod: 'CARD', items: [{ ticketTypeId: ticketTypeIds[0]!, quantity: 1 }] };
    const unverified = await createUser({ verified: false });
    const r1 = await order(await bearerFor(unverified.id), body);
    expect(r1.status).toBe(403);
    expect(r1.body.error.code).toBe('EMAIL_NOT_VERIFIED');
    await getDb().event.update({ where: { id: eventId }, data: { salesStartAt: new Date(Date.now() + 3600_000) } });
    const r2 = await order(buyer.auth, body);
    expect(r2.status).toBe(409);
    expect(r2.body.error.code).toBe('SALES_CLOSED');
    const draft = await createEvent(org, { ticketTypes: [{ name: 'A', capacity: 10, priceCents: 1000 }] });
    await order(buyer.auth, { ...body, eventId: draft.eventId, items: [{ ticketTypeId: draft.ticketTypeIds[0]!, quantity: 1 }] }).expect(404);
    // Type de place d'un autre événement (ventes rouvertes pour atteindre ce contrôle).
    await getDb().event.update({ where: { id: eventId }, data: { salesStartAt: new Date(Date.now() - 3600_000) } });
    await order(buyer.auth, { ...body, items: [{ ticketTypeId: draft.ticketTypeIds[0]!, quantity: 1 }] }).expect(404);
  });

  it('Idempotency-Key obligatoire et au format UUID ; items uniques', async () => {
    const { eventId, ticketTypeIds } = await publishedEvent([{ name: 'A', capacity: 10, priceCents: 1000 }]);
    const body = { eventId, paymentMethod: 'CARD', items: [{ ticketTypeId: ticketTypeIds[0]!, quantity: 1 }] };
    await api().post('/api/v1/orders').set(buyer.auth).send(body).expect(400);
    await order(buyer.auth, body, 'pas-un-uuid').expect(400);
    await order(buyer.auth, { ...body, items: [{ ticketTypeId: ticketTypeIds[0]!, quantity: 1 }, { ticketTypeId: ticketTypeIds[0]!, quantity: 1 }] }).expect(400);
  });

  it('virement : indisponible sans coordonnées bancaires ; sinon instructions à l’acheteur seulement', async () => {
    const { eventId, ticketTypeIds } = await publishedEvent([{ name: 'A', capacity: 10, priceCents: 1500 }]);
    const body = { eventId, paymentMethod: 'TRANSFER', items: [{ ticketTypeId: ticketTypeIds[0]!, quantity: 2 }] };
    const unavailable = await order(buyer.auth, body);
    expect(unavailable.status).toBe(422);
    expect(unavailable.body.error.code).toBe('PAYMENT_METHOD_UNAVAILABLE');
    await api().patch(`/api/v1/orgs/${org.id}/settings`).set(org.owner.auth)
      .send({ transferHoldHours: 48, bank: { beneficiary: 'Collectif', iban: 'FR7630006000011234567890189', bic: 'AGRIFRPP' }, currentPassword: PASSWORD }).expect(200);
    const res = await order(buyer.auth, body).expect(201);
    expect(res.body.status).toBe('AWAITING_TRANSFER');
    expect(res.body.transferInstructions).toEqual({
      beneficiary: 'Collectif', iban: 'FR7630006000011234567890189', bic: 'AGRIFRPP',
      reference: expect.stringMatching(/^NG-[A-Z2-9]{10}$/), amountCents: 3000, deadline: res.body.expiresAt,
    });
    const hours = (new Date(res.body.expiresAt as string).getTime() - Date.now()) / 3600_000;
    expect(hours).toBeGreaterThan(47.9);
    // Le mail d'instructions est en outbox (chiffré).
    const mail = await getDb().emailOutbox.findFirstOrThrow({ where: { to: buyer.email, template: 'transferInstructions' } });
    expect(decryptOutboxPayload(mail)['reference']).toBe(res.body.transferInstructions.reference);
    // Un autre acheteur ne voit pas la commande.
    const other = await loggedInUser();
    await api().get(`/api/v1/orders/${res.body.id as string}`).set(other.auth).expect(404);
  });
});

describe('idempotence', () => {
  it('même clé + même corps ⇒ même commande (200) ; corps différent ⇒ 409', async () => {
    const { eventId, ticketTypeIds } = await publishedEvent([{ name: 'A', capacity: 10, priceCents: 1000 }]);
    const key = randomUUID();
    const body = { eventId, paymentMethod: 'CARD', items: [{ ticketTypeId: ticketTypeIds[0]!, quantity: 2 }] };
    const first = await order(buyer.auth, body, key).expect(201);
    const again = await order(buyer.auth, body, key).expect(200);
    expect(again.body.id).toBe(first.body.id);
    const conflict = await order(buyer.auth, { ...body, items: [{ ticketTypeId: ticketTypeIds[0]!, quantity: 3 }] }, key);
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe('IDEMPOTENCY_CONFLICT');
    const tt = await getDb().ticketType.findUniqueOrThrow({ where: { id: ticketTypeIds[0]! } });
    expect(tt.held).toBe(2);
  });

  it('même clé envoyée 5 fois en parallèle ⇒ une seule commande', async () => {
    const { eventId, ticketTypeIds } = await publishedEvent([{ name: 'A', capacity: 10, priceCents: 1000 }]);
    const key = randomUUID();
    const body = { eventId, paymentMethod: 'CARD', items: [{ ticketTypeId: ticketTypeIds[0]!, quantity: 1 }] };
    const results = await Promise.all(Array.from({ length: 5 }, () => order(buyer.auth, body, key)));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 200)).toHaveLength(4);
    expect(new Set(results.map((r) => r.body.id as string)).size).toBe(1);
  });

  it('la clé est propre à chaque acheteur', async () => {
    const { eventId, ticketTypeIds } = await publishedEvent([{ name: 'A', capacity: 10, priceCents: 1000 }]);
    const key = randomUUID();
    const body = { eventId, paymentMethod: 'CARD', items: [{ ticketTypeId: ticketTypeIds[0]!, quantity: 1 }] };
    const mine = await order(buyer.auth, body, key).expect(201);
    const other = await loggedInUser();
    const theirs = await order(other.auth, body, key).expect(201);
    expect(theirs.body.id).not.toBe(mine.body.id);
  });
});

describe('lecture des commandes', () => {
  it('liste paginée et détail limités aux commandes de l’acheteur', async () => {
    const { eventId, ticketTypeIds } = await publishedEvent([{ name: 'A', capacity: 10, priceCents: 1000 }]);
    const body = { eventId, paymentMethod: 'CARD', items: [{ ticketTypeId: ticketTypeIds[0]!, quantity: 1 }] };
    const mine = await order(buyer.auth, body).expect(201);
    const other = await loggedInUser();
    await order(other.auth, body).expect(201);
    const list = await api().get('/api/v1/orders').set(buyer.auth).expect(200);
    expect(list.body).toMatchObject({ page: 1, pageSize: 20, total: 1 });
    expect(list.body.items[0].id).toBe(mine.body.id);
    await api().get(`/api/v1/orders/${mine.body.id as string}`).set(other.auth).expect(404);
    await api().get(`/api/v1/orders/${mine.body.id as string}`).set(buyer.auth).expect(200);
    await api().get('/api/v1/orders').expect(401);
  });
});

describe('expiration des réservations', () => {
  it('le worker expire les commandes échues et libère les places', async () => {
    const { eventId, ticketTypeIds } = await publishedEvent([{ name: 'A', capacity: 5, priceCents: 1000 }]);
    const res = await order(buyer.auth, { eventId, paymentMethod: 'CARD', items: [{ ticketTypeId: ticketTypeIds[0]!, quantity: 5 }] }).expect(201);
    const other = await loggedInUser();
    const blocked = await order(other.auth, { eventId, paymentMethod: 'CARD', items: [{ ticketTypeId: ticketTypeIds[0]!, quantity: 1 }] });
    expect(blocked.status).toBe(409);
    // Pas encore échue : rien ne bouge.
    expect((await expireOrders()).expired).toBe(0);
    await getDb().order.update({ where: { id: res.body.id as string }, data: { expiresAt: new Date(Date.now() - 60_000) } });
    const { expired, ticketTypeIds: released } = await expireOrders();
    expect(expired).toBe(1);
    expect(released).toEqual([ticketTypeIds[0]]);
    const after = await api().get(`/api/v1/orders/${res.body.id as string}`).set(buyer.auth).expect(200);
    expect(after.body).toMatchObject({ status: 'EXPIRED', refundPreviewCents: null });
    const tt = await getDb().ticketType.findUniqueOrThrow({ where: { id: ticketTypeIds[0]! } });
    expect(tt.held).toBe(0);
    await order(other.auth, { eventId, paymentMethod: 'CARD', items: [{ ticketTypeId: ticketTypeIds[0]!, quantity: 1 }] }).expect(201);
    expect(await getDb().emailOutbox.count({ where: { to: buyer.email, template: 'orderExpired' } })).toBe(1);
  });

  it('trois workers en parallèle (SKIP LOCKED) : chaque commande n’est expirée qu’une fois', async () => {
    const { eventId, ticketTypeIds } = await publishedEvent([{ name: 'A', capacity: 50, priceCents: 1000 }]);
    for (let i = 0; i < 5; i += 1) {
      const u = await createUser();
      await order(await bearerFor(u.id), { eventId, paymentMethod: 'CARD', items: [{ ticketTypeId: ticketTypeIds[0]!, quantity: 2 }] }).expect(201);
    }
    await getDb().order.updateMany({ data: { expiresAt: new Date(Date.now() - 60_000) } });
    // Sans verrou consultatif : seul FOR UPDATE SKIP LOCKED répartit le travail entre workers.
    const results = await Promise.all([expireOrders(), expireOrders(), expireOrders()]);
    expect(results.reduce((n, r) => n + r.expired, 0)).toBe(5);
    const tt = await getDb().ticketType.findUniqueOrThrow({ where: { id: ticketTypeIds[0]! } });
    expect(tt.held).toBe(0);
    await setStock(ticketTypeIds[0]!, 0, 0);
  });
});
