import { randomBytes, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EnvValidationError, parseEnv } from '../../src/config/env.js';
import { expireOrders } from '../../src/jobs/expireOrders.js';
import { workerJobs } from '../../src/jobs/schedule.js';
import { testClock } from '../../src/lib/clock.js';
import { getDb, transaction } from '../../src/lib/db.js';
import { AppError } from '../../src/lib/errors.js';
import { updateSettings } from '../../src/modules/orgs/service.js';
import { distributeWaitlist } from '../../src/modules/waitlist/distribute.js';
import { api, createUser, loggedInUser, type LoggedIn } from '../helpers.js';
import { createEvent, orgWithStaff, setStock, type OrgFixture } from '../fixtures.js';
import { MAX_ACCUMULATION_MINUTES } from '../../src/config/waitlist.js';

let org: OrgFixture;
let buyer: LoggedIn;

beforeEach(async () => {
  org = await orgWithStaff('collectif-b9-infra');
  buyer = await loggedInUser({ email: 'client-b9-infra@test.fr' });
});
afterEach(() => {
  testClock.reset();
});

const order = (who: LoggedIn, eventId: string, ticketTypeId: string, quantity = 1) =>
  api().post('/api/v1/orders').set(who.auth).set('Idempotency-Key', randomUUID())
    .send({ eventId, paymentMethod: 'CARD', items: [{ ticketTypeId, quantity }] });

describe('configuration (B9 B4)', () => {
  const prod = () => ({
    ...process.env, NODE_ENV: 'production', REFRESH_COOKIE_SECURE: 'true', AUTH_RESPONSE_FLOOR_MS: '400',
    SMTP_REQUIRE_TLS: 'true', FRONT_URL: 'https://billetterie.example', PSP_BASE_URL: 'https://psp.example',
  });

  it('secrets comparés après décodage en octets, anciens secrets compris', () => {
    const bytes = Buffer.alloc(32, 0xfb); // encodages base64 et base64url différents (« + » / « - »)
    expect(bytes.toString('base64')).not.toBe(bytes.toString('base64url'));
    expect(() => parseEnv({ ...process.env, DATA_ENCRYPTION_KEY: bytes.toString('base64'), PSP_WEBHOOK_SECRET: bytes.toString('base64url') }))
      .toThrow(/distincts/);
    expect(() => parseEnv({ ...process.env, JWT_PREVIOUS_SECRETS: `ancien:${process.env['PSP_API_KEY']!}` })).toThrow(/distincts/);
    expect(() => parseEnv({ ...process.env, JWT_PREVIOUS_SECRETS: `ancien:${randomBytes(32).toString('base64url')}` })).not.toThrow();
  });

  it('production : FRONT_URL et PSP_BASE_URL en https, SMTP chiffré obligatoires', () => {
    expect(() => parseEnv(prod())).not.toThrow();
    expect(() => parseEnv({ ...prod(), FRONT_URL: 'http://billetterie.example' })).toThrow(/FRONT_URL doit être en https/);
    expect(() => parseEnv({ ...prod(), PSP_BASE_URL: 'http://psp.example' })).toThrow(/PSP_BASE_URL doit être en https/);
    expect(() => parseEnv({ ...prod(), SMTP_REQUIRE_TLS: 'false', SMTP_SECURE: 'false' })).toThrow(EnvValidationError);
    expect(() => parseEnv({ ...prod(), SMTP_REQUIRE_TLS: 'false', SMTP_SECURE: 'true' })).not.toThrow();
    expect(parseEnv(prod()).smtp.requireTls).toBe(true);
  });
});

describe('fenêtre de contrôle (B9 B5)', () => {
  async function scanAt(startsInHours: number) {
    const start = Date.now() + startsInHours * 3600_000;
    const { eventId } = await createEvent(org, {
      body: { startsAt: new Date(start).toISOString(), endsAt: new Date(start + 3600_000).toISOString(), salesEndAt: new Date(start).toISOString() },
      ticketTypes: [{ name: 'A', capacity: 5, priceCents: 0 }], publish: true,
    });
    return api().post(`/api/v1/orgs/${org.id}/events/${eventId}/checkin/scan`).set(org.scanner.auth)
      .send({ qrPayload: 'NG1.x', deviceId: randomUUID(), scanId: randomUUID() });
  }

  it('ouverte à startsAt − 12 h, fermée avant (404) et après endsAt + 24 h (404)', async () => {
    expect((await scanAt(13)).status).toBe(404);
    expect((await scanAt(11)).status).toBe(200);
    const { eventId } = await createEvent(org, { ticketTypes: [{ name: 'A', capacity: 5, priceCents: 0 }], publish: true });
    const event = await getDb().event.findUniqueOrThrow({ where: { id: eventId } });
    testClock.freeze(new Date(event.endsAt.getTime() + 24 * 3600_000 + 1));
    const late = await api().post(`/api/v1/orgs/${org.id}/events/${eventId}/checkin/scan`).set(org.scanner.auth)
      .send({ qrPayload: 'NG1.x', deviceId: randomUUID(), scanId: randomUUID() });
    expect(late.status).toBe(404);
  });
});

describe('réglages du collectif (B9 B6)', () => {
  it('OWNER rétrogradé pendant la ré-authentification ⇒ 403, rien n’est modifié', async () => {
    await getDb().membership.updateMany({ where: { orgId: org.id, userId: org.owner.id }, data: { role: 'MANAGER' } });
    const attempt = updateSettings(org.id, org.owner.id, { refundPercent: 10 });
    await expect(attempt).rejects.toBeInstanceOf(AppError);
    await expect(attempt).rejects.toMatchObject({ status: 403 });
    expect((await getDb().organizationSettings.findUniqueOrThrow({ where: { orgId: org.id } })).refundPercent).not.toBe(10);
  });
});

describe('filet en base (B9)', () => {
  it('mise à jour SQL directe du statut d’une commande ⇒ billets annulés par le déclencheur', async () => {
    const { eventId, ticketTypeIds } = await createEvent(org, { ticketTypes: [{ name: 'A', capacity: 5, priceCents: 0 }], publish: true });
    const res = await order(buyer, eventId, ticketTypeIds[0]!, 2).expect(201);
    const orderId = res.body.id as string;
    expect(res.body.status).toBe('PAID');
    await getDb().$executeRaw`UPDATE "orders" SET "status" = 'CANCELLED' WHERE "id" = ${orderId}::uuid`;
    const tickets = await getDb().ticket.findMany({ where: { orderItem: { orderId } } });
    expect(tickets).toHaveLength(2);
    expect(tickets.every((t) => t.status === 'CANCELLED')).toBe(true);
  });
});

describe('liste d’attente : accumulation bornée (B9 M5)', () => {
  it('N comptes jetables ne gèlent pas les ventes : une seule accumulation, ≤ 30 min, puis vente au public', async () => {
    const { eventId, ticketTypeIds } = await createEvent(org, { ticketTypes: [{ name: 'A', capacity: 4, priceCents: 1000 }], publish: true });
    const ttId = ticketTypeIds[0]!;
    await getDb().event.update({ where: { id: eventId }, data: { waitlistOfferMinutes: 240 } });
    await setStock(ttId, 4);
    const t0 = Date.now();
    for (let i = 0; i < 5; i += 1) {
      const u = await createUser();
      await getDb().waitlistEntry.create({ data: { ticketTypeId: ttId, eventId, userId: u.id, quantity: 3, createdAt: new Date(t0 - 60_000 + i) } });
    }
    await setStock(ttId, 3); // une place libérée
    await transaction((tx) => distributeWaitlist(tx, ttId));
    const entries = await getDb().waitlistEntry.findMany({ where: { ticketTypeId: ttId }, orderBy: { createdAt: 'asc' } });
    const head = entries[0]!;
    expect(head.accumulatingUntil!.getTime()).toBeLessThanOrEqual(Date.now() + MAX_ACCUMULATION_MINUTES * 60_000);
    expect(entries.slice(1).every((e) => e.accumulatingUntil === null)).toBe(true);
    // Pendant l'accumulation : la place est réservée à la tête de file.
    const other = await loggedInUser();
    expect((await order(other, eventId, ttId)).status).toBe(409);
    // Fenêtre échue : la tête est sautée, aucune autre entrée n'accumule, la place part au public.
    testClock.freeze(new Date(head.accumulatingUntil!.getTime() + 1));
    await transaction((tx) => distributeWaitlist(tx, ttId));
    const after = await getDb().waitlistEntry.findMany({ where: { ticketTypeId: ttId } });
    expect(after.filter((e) => e.accumulatingUntil !== null && !e.accumulationSkipped)).toHaveLength(0);
    expect((await order(other, eventId, ttId)).status).toBe(201);
  });
});

describe('worker et horloge (B9 B1 / B2)', () => {
  it('annulations d’événement traitées avant le rapprochement et l’expiration', () => {
    const names = workerJobs().map(([name]) => name);
    expect(names).not.toContain('outbox'); // boucle séparée (audit M3)
    expect(names.indexOf('eventCancellations')).toBeLessThan(names.indexOf('reconcilePayments'));
    expect(names.indexOf('reconcilePayments')).toBeLessThan(names.indexOf('expireOrders'));
  });

  it('l’expiration suit l’horloge de l’application, pas now() de la base', async () => {
    const { eventId, ticketTypeIds } = await createEvent(org, { ticketTypes: [{ name: 'A', capacity: 5, priceCents: 1000 }], publish: true });
    const res = await order(buyer, eventId, ticketTypeIds[0]!).expect(201);
    const { expiresAt } = await getDb().order.findUniqueOrThrow({ where: { id: res.body.id as string } });
    expect((await expireOrders()).expired).toBe(0);
    testClock.freeze(new Date(expiresAt!.getTime() + 1));
    expect((await expireOrders()).expired).toBe(1);
  });
});
