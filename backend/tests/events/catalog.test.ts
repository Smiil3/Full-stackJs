import { beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../../src/lib/db.js';
import { PASSWORD, api } from '../helpers.js';
import { createEvent, orgWithStaff, setStock, type OrgFixture } from '../fixtures.js';

let a: OrgFixture;
let b: OrgFixture;

beforeEach(async () => {
  a = await orgWithStaff('collectif-cat-a');
  b = await orgWithStaff('collectif-cat-b');
});

describe('catalogue public', () => {
  it('ne liste que les événements publiés et à venir, triés par date', async () => {
    await createEvent(a, { body: { title: 'Brouillon' }, ticketTypes: [{ name: 'T', capacity: 10, priceCents: 1000 }] });
    const later = await createEvent(a, { body: { title: 'Plus tard' }, ticketTypes: [{ name: 'T', capacity: 10, priceCents: 1000 }], publish: true });
    const soon = await createEvent(b, {
      body: { title: 'Bientôt', startsAt: new Date(Date.now() + 2 * 86400_000).toISOString(), endsAt: new Date(Date.now() + 3 * 86400_000).toISOString(), salesEndAt: new Date(Date.now() + 2 * 86400_000).toISOString() },
      ticketTypes: [{ name: 'T', capacity: 10, priceCents: 500 }], publish: true,
    });
    const past = await createEvent(a, { body: { title: 'Passé' }, ticketTypes: [{ name: 'T', capacity: 10, priceCents: 1000 }], publish: true });
    await getDb().event.update({ where: { id: past.eventId }, data: { startsAt: new Date(Date.now() - 5 * 3600_000), endsAt: new Date(Date.now() - 3600_000), salesEndAt: new Date(Date.now() - 3600_000) } });
    const res = await api().get('/api/v1/events').expect(200);
    expect((res.body.items as { id: string }[]).map((e) => e.id)).toEqual([soon.eventId, later.eventId]);
    expect(res.body.total).toBe(2);
    const filtered = await api().get(`/api/v1/events?orgSlug=${b.slug}`).expect(200);
    expect(filtered.body.total).toBe(1);
    expect(filtered.body.items[0].orgSlug).toBe(b.slug);
  });

  it('détail : 404 si non publié ; aucun chiffre exact de stock ni donnée bancaire', async () => {
    const draft = await createEvent(a, { ticketTypes: [{ name: 'T', capacity: 10, priceCents: 1000 }] });
    await api().get(`/api/v1/events/${draft.eventId}`).expect(404);
    await api().get('/api/v1/events/pas-un-uuid').expect(400);
    await api().patch(`/api/v1/orgs/${a.id}/settings`).set(a.owner.auth)
      .send({ bank: { beneficiary: 'A', iban: 'FR7630006000011234567890189', bic: 'AGRIFRPP' }, currentPassword: PASSWORD, contactEmail: 'contact@a.fr' }).expect(200);
    const pub = await createEvent(a, { ticketTypes: [{ name: 'Fosse', capacity: 100, priceCents: 1500 }], publish: true });
    const res = await api().get(`/api/v1/events/${pub.eventId}`).expect(200);
    const raw = JSON.stringify(res.body);
    for (const forbidden of ['capacity', '"sold"', '"held"', 'remaining', 'iban', 'IBAN', '30006000', 'AGRIFRPP', 'bankBeneficiary']) {
      expect(raw).not.toContain(forbidden);
    }
    expect(res.body).toMatchObject({ salesOpen: true, contactEmail: 'contact@a.fr', rules: { transferEnabled: true } });
  });

  it('disponibilité AVAILABLE / LOW (≤ 10 %) / SOLD_OUT, et SOLD_OUT tant qu’une liste d’attente existe', async () => {
    const { eventId, ticketTypeIds } = await createEvent(a, {
      ticketTypes: [{ name: 'A', capacity: 100, priceCents: 1000 }, { name: 'B', capacity: 100, priceCents: 1000 }, { name: 'C', capacity: 100, priceCents: 1000 }],
      publish: true,
    });
    await setStock(ticketTypeIds[0]!, 89, 0);
    await setStock(ticketTypeIds[1]!, 85, 5);
    await setStock(ticketTypeIds[2]!, 100, 0);
    const res = await api().get(`/api/v1/events/${eventId}`).expect(200);
    expect((res.body.ticketTypes as { availability: string }[]).map((t) => t.availability)).toEqual(['AVAILABLE', 'LOW', 'SOLD_OUT']);
    expect(res.body.coverAvailability).toBe('AVAILABLE');
    // Des places restent en A, mais une personne attend : complet pour le public.
    await getDb().waitlistEntry.create({ data: { ticketTypeId: ticketTypeIds[0]!, eventId, userId: a.scanner.id, quantity: 20 } });
    const after = await api().get(`/api/v1/events/${eventId}`).expect(200);
    expect(after.body.ticketTypes[0].availability).toBe('SOLD_OUT');
    expect(after.body.coverAvailability).toBe('LOW');
  });

  it('tarif early calculé serveur : appliqué avant earlyUntil, prix normal à partir de earlyUntil', async () => {
    const until = new Date(Date.now() + 3600_000);
    const { eventId, ticketTypeIds } = await createEvent(a, {
      ticketTypes: [{ name: 'Early', capacity: 10, priceCents: 2500, earlyPriceCents: 1800, earlyUntil: until.toISOString() }],
      publish: true,
    });
    const early = await api().get(`/api/v1/events/${eventId}`).expect(200);
    expect(early.body.ticketTypes[0]).toMatchObject({ currentPriceCents: 1800, regularPriceCents: 2500, isEarly: true, earlyUntil: until.toISOString() });
    expect(early.body.fromPriceCents).toBe(1800);
    await getDb().ticketType.update({ where: { id: ticketTypeIds[0]! }, data: { earlyUntil: new Date(Date.now() - 1) } });
    const regular = await api().get(`/api/v1/events/${eventId}`).expect(200);
    expect(regular.body.ticketTypes[0]).toMatchObject({ currentPriceCents: 2500, isEarly: false, earlyUntil: null });
  });

  it('filtres de dates et pagination validés', async () => {
    await api().get('/api/v1/events?from=hier').expect(400);
    await api().get('/api/v1/events?page=0').expect(400);
    await api().get('/api/v1/events?orgSlug=../../etc').expect(400);
    const res = await api().get(`/api/v1/events?from=${encodeURIComponent(new Date().toISOString())}`).expect(200);
    expect(res.body).toMatchObject({ items: [], page: 1, pageSize: 20, total: 0 });
  });
});
