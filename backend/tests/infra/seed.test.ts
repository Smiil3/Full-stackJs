import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { getDb } from '../../src/lib/db.js';
import { runSeed, SEED_ACCOUNTS } from '../../prisma/seedData.js';
import { api } from '../helpers.js';

const SEED_PWD = 'mot-de-passe-de-seed-pour-les-tests';

describe('seed de démonstration', () => {
  it('seed puis commande par virement : coordonnées bancaires déchiffrables par le service (bug 500)', async () => {
    process.env['SEED_PASSWORD'] = SEED_PWD;
    try {
      await runSeed();
    } finally {
      delete process.env['SEED_PASSWORD'];
    }
    expect(await getDb().user.count({ where: { email: { in: SEED_ACCOUNTS } } })).toBe(SEED_ACCOUNTS.length);
    const login = await api().post('/api/v1/auth/login').send({ email: 'acheteur@nuits-garonne.test', password: SEED_PWD }).expect(200);
    const auth = { Authorization: `Bearer ${login.body.accessToken as string}` };
    const event = await getDb().event.findFirstOrThrow({ where: { title: 'Jazz au Hangar' }, include: { ticketTypes: { orderBy: { sortOrder: 'asc' } } } });
    const pub = await api().get(`/api/v1/events/${event.id}`).expect(200);
    expect(pub.body.rules.transferEnabled).toBe(true);
    const res = await api().post('/api/v1/orders').set(auth).set('Idempotency-Key', randomUUID())
      .send({ eventId: event.id, paymentMethod: 'TRANSFER', items: [{ ticketTypeId: event.ticketTypes[1]!.id, quantity: 1 }] });
    expect(res.status).toBe(201);
    expect(res.body.transferInstructions.iban).toBe('FR7630006000011234567890189');
    // La commande par virement créée par le seed est elle aussi lisible.
    const orders = await api().get('/api/v1/orders').set(auth).expect(200);
    expect((orders.body.items as { status: string }[]).filter((o) => o.status === 'AWAITING_TRANSFER')).toHaveLength(2);
  });

  it('base déjà peuplée : resynchronisation non destructive (mot de passe et IBAN au format courant)', async () => {
    process.env['SEED_PASSWORD'] = SEED_PWD;
    try {
      await runSeed();
      const usersBefore = await getDb().user.count();
      // Simulation d'une base seedée avec un ancien format de chiffrement.
      await getDb().organizationSettings.updateMany({ data: { bankIbanEncrypted: 'v1.ancien.format' } });
      process.env['SEED_PASSWORD'] = 'un-autre-mot-de-passe-de-seed';
      await runSeed();
      expect(await getDb().user.count()).toBe(usersBefore);
    } finally {
      delete process.env['SEED_PASSWORD'];
    }
    await api().post('/api/v1/auth/login').send({ email: 'owner@nuits.test', password: 'un-autre-mot-de-passe-de-seed' }).expect(200);
    const settings = await getDb().organizationSettings.findMany();
    expect(settings.every((s) => s.bankIbanEncrypted?.split('.').length === 5)).toBe(true);
  });
});
