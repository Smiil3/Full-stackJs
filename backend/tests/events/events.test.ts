import { beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../../src/lib/db.js';
import { api } from '../helpers.js';
import { createEvent, eventBody, orgWithStaff, setStock, type OrgFixture } from '../fixtures.js';

let a: OrgFixture;
const ev = (path = '') => `/api/v1/orgs/${a.id}/events${path}`;

beforeEach(async () => {
  a = await orgWithStaff('collectif-ev');
});

describe('événements (back-office)', () => {
  it('création en brouillon, réponse EventAdmin complète', async () => {
    const res = await api().post(ev()).set(a.manager.auth).send(eventBody({ description: 'Ligne 1\nLigne 2' })).expect(201);
    expect(res.body).toMatchObject({ orgId: a.id, status: 'DRAFT', title: 'Nuit test', description: 'Ligne 1\nLigne 2', ticketTypes: [] });
    expect(res.body.overrides).toEqual({
      cardHoldMinutes: null, transferHoldHours: null, transferEnabled: null, cancellationDeadlineHours: null,
      selfCancellationEnabled: null, refundPercent: null, maxPerOrder: null, maxPerUser: null, waitlistOfferMinutes: null,
      waitlistEnabled: null, serviceFeeFixedCents: null, serviceFeeBasisPoints: null,
    });
    expect(res.body.effectiveRules.maxPerOrder).toBe(6);
  });

  it('dates incohérentes, fuseau inconnu, date sans fuseau ⇒ 400', async () => {
    const start = new Date(Date.now() + 10 * 86400_000);
    for (const body of [
      eventBody({ endsAt: start.toISOString(), startsAt: new Date(start.getTime() + 1000).toISOString() }),
      eventBody({ salesEndAt: new Date(start.getTime() + 100 * 86400_000).toISOString() }),
      eventBody({ timezone: 'Europe/Bordeaux' }),
      eventBody({ startsAt: '2030-01-01T20:00:00' }),
      eventBody({ title: '' }),
      eventBody({ status: 'PUBLISHED' }),
      eventBody({ orgId: '11111111-1111-4111-8111-111111111111' }),
    ]) {
      const res = await api().post(ev()).set(a.manager.auth).send(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
  });

  it('héritage des réglages : collectif → événement, surcharge prioritaire', async () => {
    const plain = await createEvent(a);
    const custom = await createEvent(a, { body: { overrides: { refundPercent: 50, maxPerOrder: 2 } } });
    await api().patch(`/api/v1/orgs/${a.id}/settings`).set(a.owner.auth).send({ refundPercent: 80, cardHoldMinutes: 30 }).expect(200);
    const p = await api().get(ev(`/${plain.eventId}`)).set(a.scanner.auth).expect(200);
    expect(p.body.effectiveRules).toMatchObject({ refundPercent: 80, cardHoldMinutes: 30, maxPerOrder: 6 });
    const c = await api().get(ev(`/${custom.eventId}`)).set(a.scanner.auth).expect(200);
    expect(c.body.overrides).toMatchObject({ refundPercent: 50, maxPerOrder: 2, cardHoldMinutes: null });
    expect(c.body.effectiveRules).toMatchObject({ refundPercent: 50, maxPerOrder: 2, cardHoldMinutes: 30 });
    // Retour à l'héritage : surcharge remise à null.
    await api().patch(ev(`/${custom.eventId}`)).set(a.manager.auth).send({ overrides: { refundPercent: null } }).expect(200);
    const back = await api().get(ev(`/${custom.eventId}`)).set(a.scanner.auth).expect(200);
    expect(back.body.effectiveRules.refundPercent).toBe(80);
    expect(back.body.overrides.maxPerOrder).toBe(2);
  });

  it('surcharges : bornes et maxPerUser ≥ maxPerOrder', async () => {
    for (const overrides of [{ cardHoldMinutes: 61 }, { refundPercent: 150 }, { maxPerOrder: 8, maxPerUser: 4 }, { maxPerUser: 2 }, { unknown: 1 }]) {
      const res = await api().post(ev()).set(a.manager.auth).send(eventBody({ overrides }));
      expect(res.status, JSON.stringify(overrides)).toBe(400);
    }
  });

  it('virement exposé seulement s’il est utilisable (coordonnées bancaires présentes)', async () => {
    const { eventId } = await createEvent(a);
    const before = await api().get(ev(`/${eventId}`)).set(a.manager.auth).expect(200);
    expect(before.body.effectiveRules.transferEnabled).toBe(false);
    await api().patch(`/api/v1/orgs/${a.id}/settings`).set(a.owner.auth)
      .send({ bank: { beneficiary: 'A', iban: 'FR7630006000011234567890189', bic: 'AGRIFRPP' } }).expect(200);
    const after = await api().get(ev(`/${eventId}`)).set(a.manager.auth).expect(200);
    expect(after.body.effectiveRules.transferEnabled).toBe(true);
  });

  it('publication : refusée sans type de place, puis une seule fois', async () => {
    const { eventId } = await createEvent(a);
    const none = await api().post(ev(`/${eventId}/publish`)).set(a.manager.auth);
    expect(none.status).toBe(409);
    expect(none.body.error.code).toBe('CONFLICT');
    await api().post(ev(`/${eventId}/ticket-types`)).set(a.manager.auth).send({ name: 'Fosse', capacity: 100, priceCents: 1500 }).expect(201);
    const ok = await api().post(ev(`/${eventId}/publish`)).set(a.manager.auth).expect(200);
    expect(ok.body.status).toBe('PUBLISHED');
    const again = await api().post(ev(`/${eventId}/publish`)).set(a.manager.auth);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('INVALID_STATE');
  });

  it('événement annulé : plus modifiable (409)', async () => {
    const { eventId } = await createEvent(a);
    await getDb().event.update({ where: { id: eventId }, data: { status: 'CANCELLED' } });
    const res = await api().patch(ev(`/${eventId}`)).set(a.manager.auth).send({ title: 'Nouveau titre' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INVALID_STATE');
    await api().post(ev(`/${eventId}/ticket-types`)).set(a.manager.auth).send({ name: 'X', capacity: 1, priceCents: 0 }).expect(409);
  });

  it('liste paginée filtrable par statut', async () => {
    await createEvent(a);
    await createEvent(a, { ticketTypes: [{ name: 'T', capacity: 5, priceCents: 0 }], publish: true });
    const all = await api().get(ev('?pageSize=1')).set(a.scanner.auth).expect(200);
    expect(all.body).toMatchObject({ page: 1, pageSize: 1, total: 2 });
    expect(all.body.items).toHaveLength(1);
    const published = await api().get(ev('?status=PUBLISHED')).set(a.scanner.auth).expect(200);
    expect(published.body.total).toBe(1);
    await api().get(ev('?pageSize=101')).set(a.scanner.auth).expect(400);
    await api().get(ev('?status=ARCHIVED')).set(a.scanner.auth).expect(400);
  });
});

describe('types de places', () => {
  it('tarif early : les deux champs ou aucun, early < prix normal', async () => {
    const { eventId } = await createEvent(a);
    const url = ev(`/${eventId}/ticket-types`);
    const until = new Date(Date.now() + 86400_000).toISOString();
    await api().post(url).set(a.manager.auth).send({ name: 'A', capacity: 10, priceCents: 2000, earlyPriceCents: 1500 }).expect(400);
    await api().post(url).set(a.manager.auth).send({ name: 'A', capacity: 10, priceCents: 2000, earlyUntil: until }).expect(400);
    await api().post(url).set(a.manager.auth).send({ name: 'A', capacity: 10, priceCents: 2000, earlyPriceCents: 2000, earlyUntil: until }).expect(400);
    const ok = await api().post(url).set(a.manager.auth).send({ name: 'A', capacity: 10, priceCents: 2000, earlyPriceCents: 1500, earlyUntil: until }).expect(201);
    expect(ok.body).toMatchObject({ capacity: 10, sold: 0, held: 0, remaining: 10, priceCents: 2000, earlyPriceCents: 1500, earlyUntil: until });
    // PATCH : relever l'early au-dessus du nouveau prix est refusé.
    await api().patch(ev(`/${eventId}/ticket-types/${ok.body.id as string}`)).set(a.manager.auth).send({ priceCents: 1400 }).expect(400);
  });

  it('bornes : capacité 1–100000, prix 0–1000000, sortOrder', async () => {
    const { eventId } = await createEvent(a);
    const url = ev(`/${eventId}/ticket-types`);
    for (const body of [
      { name: 'A', capacity: 0, priceCents: 0 }, { name: 'A', capacity: 100_001, priceCents: 0 },
      { name: 'A', capacity: 1, priceCents: -1 }, { name: 'A', capacity: 1, priceCents: 1_000_001 },
      { name: 'A', capacity: 1, priceCents: 10.5 }, { name: '', capacity: 1, priceCents: 0 },
      { name: 'A', capacity: 1, priceCents: 0, sold: 5 },
    ]) {
      const res = await api().post(url).set(a.manager.auth).send(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
  });

  it('réduction de capacité sous vendus + bloqués ⇒ 409 CONFLICT', async () => {
    const { eventId, ticketTypeIds } = await createEvent(a, { ticketTypes: [{ name: 'Balcon', capacity: 50, priceCents: 2000 }] });
    await setStock(ticketTypeIds[0]!, 30, 10);
    const url = ev(`/${eventId}/ticket-types/${ticketTypeIds[0]!}`);
    const res = await api().patch(url).set(a.manager.auth).send({ capacity: 39 });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
    const ok = await api().patch(url).set(a.manager.auth).send({ capacity: 40 }).expect(200);
    expect(ok.body.remaining).toBe(0);
  });

  it('suppression : impossible s’il y a déjà des ventes ; dernier type d’un événement publié protégé', async () => {
    const { eventId, ticketTypeIds } = await createEvent(a, {
      ticketTypes: [{ name: 'A', capacity: 10, priceCents: 0 }, { name: 'B', capacity: 10, priceCents: 0 }],
      publish: true,
    });
    await setStock(ticketTypeIds[0]!, 1);
    await api().delete(ev(`/${eventId}/ticket-types/${ticketTypeIds[0]!}`)).set(a.manager.auth).expect(409);
    await setStock(ticketTypeIds[0]!, 0);
    await api().delete(ev(`/${eventId}/ticket-types/${ticketTypeIds[0]!}`)).set(a.manager.auth).expect(204);
    await api().delete(ev(`/${eventId}/ticket-types/${ticketTypeIds[1]!}`)).set(a.manager.auth).expect(409);
  });
});
