import { randomBytes, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Writable } from 'node:stream';
import supertest from 'supertest';
import Joi from 'joi';
import type { Response } from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { resetEnvCache } from '../../src/config/env.js';
import { RATE_LIMITS } from '../../src/config/rateLimits.js';
import { testClock } from '../../src/lib/clock.js';
import { csvCell } from '../../src/lib/csv.js';
import { getDb, transaction } from '../../src/lib/db.js';
import { ResponseContractError } from '../../src/lib/errors.js';
import { buildLogger } from '../../src/lib/logger.js';
import { enqueueEmail } from '../../src/lib/outbox.js';
import { checkResponse } from '../../src/middlewares/validate.js';
import { streamAttendees } from '../../src/modules/reports/attendees.js';
import { api, loggedInUser, type LoggedIn } from '../helpers.js';
import { createEvent, orgWithStaff, type OrgFixture } from '../fixtures.js';

let org: OrgFixture;
let buyer: LoggedIn;

beforeEach(async () => {
  org = await orgWithStaff('collectif-a1-durcissement');
  buyer = await loggedInUser({ email: 'client-a1-durcissement@test.fr' });
});
afterEach(() => {
  testClock.reset();
});

/** Commandes payées insérées directement (volumes ou montants difficiles à atteindre par l'API). */
async function paidTickets(eventId: string, ttId: string, userId: string, orders: number, unitPriceCents: number, quantity: number) {
  const db = getDb();
  const ids = Array.from({ length: orders }, () => randomUUID());
  await db.order.createMany({
    data: ids.map((id) => ({
      id, userId, eventId, status: 'PAID' as const, paymentMethod: 'CARD' as const, idempotencyKey: randomUUID(), requestHash: '0'.repeat(64),
      subtotalCents: unitPriceCents * quantity, serviceFeeCents: 0, totalCents: unitPriceCents * quantity, refundPercent: 100, serviceFeeRefundable: false, paidAt: new Date(),
    })),
  });
  const items = ids.map((orderId) => ({ id: randomUUID(), orderId, ticketTypeId: ttId, quantity, unitPriceCents }));
  await db.orderItem.createMany({ data: items });
  await db.ticket.createMany({ data: items.flatMap((it) => Array.from({ length: quantity }, (_, i) => ({ orderItemId: it.id, seq: i + 1, eventId, publicId: randomBytes(16).toString('base64url') }))) });
}

describe('journaux sans données personnelles (B9)', () => {
  it('clés ajoutées masquées jusqu’à 4 niveaux ; erreur de contrat de réponse sans valeur', () => {
    const lines: string[] = [];
    const logger = buildLogger(new Writable({ write(chunk: Buffer, _e, cb) { lines.push(chunk.toString()); cb(); } }));
    const secret = 'personne-secrete@exemple.fr';
    logger.warn({
      buyerEmail: secret, a: { contactEmail: secret, b: { ownerEmail: secret, c: { to: secret, d: { displayName: secret } } } },
      bankBeneficiary: secret, transferReference: secret, idempotencyKey: secret, link: secret,
    }, 'test');
    expect(lines.join('')).not.toContain(secret);

    let problems: string[] = [];
    try {
      checkResponse(Joi.object({ code: Joi.string().pattern(/^a$/) }), { code: secret });
    } catch (err) {
      if (err instanceof ResponseContractError) problems = err.problems;
    }
    expect(problems).toEqual(['code: string.pattern.base']);
  });
});

describe('CSV indépendant du séparateur (B10)', () => {
  it('cellules contenant une virgule citées ; formules neutralisées après tout blanc de tête', () => {
    expect(csvCell('x,=1+1')).toBe('"x,=1+1"');
    expect(csvCell(' \t=1+1')).toBe(`' \t=1+1`);
    const nbsp = String.fromCharCode(0xa0);
    expect(csvCell(`${nbsp}@SUM(A1)`)).toBe(`'${nbsp}@SUM(A1)`);
    expect(csvCell('Dupont, Jean')).toBe('"Dupont, Jean"');
  });
});

describe('export CSV (B11)', () => {
  it('contre-pression : aucun écouteur « drain » / « close » accumulé', async () => {
    const { eventId, ticketTypeIds } = await createEvent(org, { ticketTypes: [{ name: 'A', capacity: 2000, priceCents: 1000 }], publish: true });
    await paidTickets(eventId, ticketTypeIds[0]!, buyer.id, 1200, 1000, 1);
    const fake = Object.assign(new EventEmitter(), {
      status: () => fake, setHeader: () => fake, end: () => undefined, destroy: () => undefined,
      // Tampon toujours plein : « drain » émis au tour suivant.
      write: () => { setImmediate(() => fake.emit('drain')); return false; },
    });
    await streamAttendees(org.id, org.manager.id, eventId, fake as unknown as Response);
    expect(fake.listenerCount('drain')).toBe(0);
    expect(fake.listenerCount('close')).toBeLessThanOrEqual(1);
  });

  it('audit dédoublonné (1 ligne / 5 min / compte et événement) et limiteur dédié', async () => {
    const { eventId } = await createEvent(org, { ticketTypes: [{ name: 'A', capacity: 10, priceCents: 1000 }], publish: true });
    const url = `/api/v1/orgs/${org.id}/events/${eventId}/attendees.csv`;
    await api().get(url).set(org.manager.auth).expect(200);
    await api().get(url).set(org.manager.auth).expect(200);
    expect(await getDb().auditLog.count({ where: { action: 'attendees.export' } })).toBe(1);
    testClock.freeze(new Date(Date.now() + 6 * 60_000));
    await api().get(url).set(org.manager.auth).expect(200);
    expect(await getDb().auditLog.count({ where: { action: 'attendees.export' } })).toBe(2);
    testClock.reset();
    const strict = supertest(createApp({ rateLimitMultiplier: 1 }));
    const statuses: number[] = [];
    for (let i = 0; i <= RATE_LIMITS.exportPerUser.max; i += 1) statuses.push((await strict.get(url).set(org.owner.auth)).status);
    expect(statuses.at(-1)).toBe(429);
    resetEnvCache();
  });
});

describe('durcissements divers (audit, section Info)', () => {
  it('/me/tickets : un long historique ne masque pas les événements à venir lointains', async () => {
    const past = await createEvent(org, { ticketTypes: [{ name: 'P', capacity: 1000, priceCents: 0 }] });
    await getDb().event.update({ where: { id: past.eventId }, data: { startsAt: new Date(Date.now() - 48 * 3600_000), endsAt: new Date(Date.now() - 47 * 3600_000), salesStartAt: new Date(Date.now() - 96 * 3600_000), salesEndAt: new Date(Date.now() - 48 * 3600_000) } });
    await paidTickets(past.eventId, past.ticketTypeIds[0]!, buyer.id, 510, 0, 1);
    const far = await createEvent(org, { body: { startsAt: new Date(Date.now() + 300 * 86400_000).toISOString(), endsAt: new Date(Date.now() + 301 * 86400_000).toISOString(), salesEndAt: new Date(Date.now() + 300 * 86400_000).toISOString() }, ticketTypes: [{ name: 'F', capacity: 10, priceCents: 0 }] });
    await paidTickets(far.eventId, far.ticketTypeIds[0]!, buyer.id, 1, 0, 1);
    const res = await api().get('/api/v1/me/tickets').set(buyer.auth).expect(200);
    expect(res.body.items[0].event.id).toBe(far.eventId);
  });

  it('statistiques : sommes en bigint (plus de 21 M€ par type de place)', async () => {
    const { eventId, ticketTypeIds } = await createEvent(org, { ticketTypes: [{ name: 'Gala', capacity: 5000, priceCents: 1_000_000 }], publish: true });
    await paidTickets(eventId, ticketTypeIds[0]!, buyer.id, 120, 1_000_000, 20);
    const res = await api().get(`/api/v1/orgs/${org.id}/events/${eventId}/stats`).set(org.manager.auth).expect(200);
    expect(res.body.ticketTypes[0].revenueCents).toBe(2_400_000_000);
  });

  it('réglages d’un collectif sans ligne de réglages : lus sans erreur, créés une seule fois', async () => {
    await getDb().organizationSettings.delete({ where: { orgId: org.id } });
    await api().get(`/api/v1/orgs/${org.id}/settings`).set(org.owner.auth).expect(200);
    await api().get(`/api/v1/orgs/${org.id}/settings`).set(org.owner.auth).expect(200);
    expect(await getDb().organizationSettings.count({ where: { orgId: org.id } })).toBe(1);
  });

  it('échéances posées par l’horloge applicative (outbox)', async () => {
    const at = new Date(Date.now() + 3 * 86400_000);
    testClock.freeze(at);
    await transaction((tx) => enqueueEmail(tx, 'horloge@test.fr', 'orderExpired', { displayName: 'H', eventTitle: 'E' }));
    const row = await getDb().emailOutbox.findFirstOrThrow({ where: { to: 'horloge@test.fr' } });
    expect(row.nextAttemptAt.getTime()).toBe(at.getTime());
    expect(row.createdAt.getTime()).toBe(at.getTime());
  });
});
