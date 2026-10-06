import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import supertest from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../../src/lib/db.js';
import { testClock } from '../../src/lib/clock.js';
import { createApp } from '../../src/app.js';
import { resetEnvCache } from '../../src/config/env.js';
import { loadTicketKeys, resetTicketKeys, TicketKeyError } from '../../src/lib/ticketSigning.js';
import { api, loggedInUser, type LoggedIn } from '../helpers.js';
import { createEvent, orgWithStaff, type OrgFixture } from '../fixtures.js';

let org: OrgFixture;
let buyer: LoggedIn;

beforeEach(async () => {
  org = await orgWithStaff('collectif-b61');
  buyer = await loggedInUser({ email: 'porteur@test.fr' });
});
afterEach(() => {
  testClock.reset();
});

async function eventWithTickets(quantity = 2) {
  const { eventId, ticketTypeIds } = await createEvent(org, { ticketTypes: [{ name: 'Entrée', capacity: 50, priceCents: 0 }], publish: true });
  const res = await api().post('/api/v1/orders').set(buyer.auth).set('Idempotency-Key', randomUUID())
    .send({ eventId, paymentMethod: 'CARD', items: [{ ticketTypeId: ticketTypeIds[0]!, quantity }] }).expect(201);
  const tickets = ((await api().get('/api/v1/me/tickets').set(buyer.auth)).body.items as { qrPayload: string; publicId: string; event: { id: string } }[])
    .filter((t) => t.event.id === eventId);
  return { eventId, orderId: res.body.id as string, tickets };
}
const url = (eventId: string, path: string) => `/api/v1/orgs/${org.id}/events/${eventId}/checkin/${path}`;
const scan = (eventId: string, qrPayload: string, scanId: string = randomUUID()) =>
  api().post(url(eventId, 'scan')).set(org.scanner.auth).send({ qrPayload, deviceId: randomUUID(), scanId });

describe('billets d’une commande close (B6.1 H1)', () => {
  it('filet en base : commande passée REFUNDED / CANCELLED / EXPIRED ⇒ billets VALID annulés, USED conservés', async () => {
    const { eventId, orderId, tickets } = await eventWithTickets(2);
    await scan(eventId, tickets[0]!.qrPayload).expect(200);
    // Chemin hypothétique qui oublierait d'annuler les billets : mise à jour directe du statut.
    await getDb().order.update({ where: { id: orderId }, data: { status: 'REFUNDED', refundAmountCents: 0 } });
    const statuses = await getDb().ticket.findMany({ where: { eventId }, orderBy: { publicId: 'asc' }, select: { publicId: true, status: true } });
    expect(statuses.find((t) => t.publicId === tickets[0]!.publicId)?.status).toBe('USED');
    expect(statuses.find((t) => t.publicId === tickets[1]!.publicId)?.status).toBe('CANCELLED');
    expect((await scan(eventId, tickets[1]!.qrPayload).expect(200)).body.result).toBe('CANCELLED');
  });

  it('annulation d’événement : tous les billets annulés en base, scan ⇒ CANCELLED, snapshot ⇒ 404', async () => {
    const { eventId, tickets } = await eventWithTickets(2);
    await api().post(`/api/v1/orgs/${org.id}/events/${eventId}/cancel`).set(org.owner.auth).send({ reason: 'Tempête' }).expect(200);
    expect(await getDb().ticket.count({ where: { eventId, status: { not: 'CANCELLED' } } })).toBe(0);
    expect((await scan(eventId, tickets[0]!.qrPayload).expect(200)).body).toEqual({ result: 'CANCELLED', ticket: null, usedAt: null });
    await api().get(url(eventId, 'snapshot')).set(org.scanner.auth).expect(404);
    const sync = await api().post(url(eventId, 'sync')).set(org.scanner.auth)
      .send({ deviceId: randomUUID(), scans: [{ scanId: randomUUID(), qrPayload: tickets[1]!.qrPayload, scannedAt: new Date().toISOString() }] }).expect(200);
    expect(sync.body.results[0].result).toBe('CANCELLED');
  });
});

describe('fenêtre de contrôle (B6.1 H2)', () => {
  it('brouillon ou terminé depuis plus de 24 h ⇒ 404 ; terminé depuis moins de 24 h ⇒ contrôle possible', async () => {
    const { eventId, tickets } = await eventWithTickets(1);
    const event = await getDb().event.findUniqueOrThrow({ where: { id: eventId } });
    testClock.freeze(new Date(event.endsAt.getTime() + 23 * 3600_000));
    await api().get(url(eventId, 'snapshot')).set(org.scanner.auth).expect(200);
    testClock.freeze(new Date(event.endsAt.getTime() + 25 * 3600_000));
    await api().get(url(eventId, 'snapshot')).set(org.scanner.auth).expect(404);
    await scan(eventId, tickets[0]!.qrPayload).expect(404);
    testClock.reset();
    const draft = await createEvent(org, { ticketTypes: [{ name: 'A', capacity: 5, priceCents: 0 }] });
    await api().get(url(draft.eventId, 'snapshot')).set(org.scanner.auth).expect(404);
    await scan(draft.eventId, tickets[0]!.qrPayload).expect(404);
  });
});

describe('limites et volume du contrôle (B6.1 M1 / M2 / M3)', () => {
  it('QR de format invalide : aucune ligne journalisée (table non gonflable) ; signature invalide : journalisée', async () => {
    const { eventId, tickets } = await eventWithTickets(1);
    for (let i = 0; i < 50; i += 1) await scan(eventId, `spam-${i}`).expect(200);
    expect(await getDb().checkIn.count()).toBe(0);
    const [p, ev, id, sig] = tickets[0]!.qrPayload.split('.') as [string, string, string, string];
    const badSig = `${p}.${ev}.${id}.${sig.slice(0, 40)}${sig[40] === 'A' ? 'B' : 'A'}${sig.slice(41)}`;
    expect((await scan(eventId, badSig).expect(200)).body.result).toBe('INVALID');
    expect(await getDb().checkIn.count({ where: { result: 'INVALID' } })).toBe(1);
  });

  it('base64url non canonique (dernier caractère) ⇒ INVALID', async () => {
    const { eventId, tickets } = await eventWithTickets(1);
    const [p, ev, id, sig] = tickets[0]!.qrPayload.split('.') as [string, string, string, string];
    // 64 octets en 86 caractères : les 4 bits de remplissage du dernier caractère doivent être nuls.
    const last = sig.charCodeAt(85);
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const idx = alphabet.indexOf(String.fromCharCode(last));
    const twisted = `${p}.${ev}.${id}.${sig.slice(0, 85)}${alphabet[idx + 1]!}`;
    expect(Buffer.from(twisted.split('.')[3]!, 'base64url').equals(Buffer.from(sig, 'base64url'))).toBe(true);
    expect((await scan(eventId, twisted).expect(200)).body.result).toBe('INVALID');
    expect((await scan(eventId, tickets[0]!.qrPayload).expect(200)).body.result).toBe('OK');
  });

  it('plafond de scans par contrôleur (et non par IP partagée)', async () => {
    const { eventId } = await eventWithTickets(1);
    const app = supertest(createApp({ rateLimitMultiplier: 0.05 })); // 12 scans / min / contrôleur, 120 / IP
    const other = await loggedInUser();
    await getDb().membership.create({ data: { orgId: org.id, userId: other.id, role: 'SCANNER' } });
    // Compteurs partagés en base : on repart de zéro (les requêtes de mise en place ont consommé le global par IP).
    await getDb().rateLimitBucket.deleteMany();
    const statuses: number[] = [];
    for (let i = 0; i < 13; i += 1) {
      statuses.push((await app.post(url(eventId, 'scan')).set(org.scanner.auth).send({ qrPayload: 'x', deviceId: randomUUID(), scanId: randomUUID() })).status);
    }
    expect(statuses.slice(0, 12).every((s) => s === 200)).toBe(true);
    expect(statuses[12]).toBe(429);
    // Même IP (wifi de salle), autre contrôleur : pas bloqué.
    await app.post(url(eventId, 'scan')).set(other.auth).send({ qrPayload: 'x', deviceId: randomUUID(), scanId: randomUUID() }).expect(200);
  });

  it('synchronisation : quota en nombre de scans (un lot de 500 compte pour 500)', async () => {
    const { eventId } = await eventWithTickets(1);
    const lot = () => ({ deviceId: randomUUID(), scans: Array.from({ length: 500 }, () => ({ scanId: randomUUID(), qrPayload: 'mal-forme', scannedAt: new Date().toISOString() })) });
    for (let i = 0; i < 4; i += 1) await api().post(url(eventId, 'sync')).set(org.scanner.auth).send(lot()).expect(200);
    const res = await api().post(url(eventId, 'sync')).set(org.scanner.auth).send(lot());
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('RATE_LIMITED');
  });

  it('corps de synchronisation : lu seulement après authentification ; 160 ko max ; autres routes 10 ko', async () => {
    const { eventId } = await eventWithTickets(1);
    const big = (n: number) => JSON.stringify({ deviceId: randomUUID(), scans: Array.from({ length: n }, () => ({ scanId: randomUUID(), qrPayload: 'x'.repeat(200), scannedAt: new Date().toISOString() })) });
    const heavy = big(700); // > 160 ko
    expect(heavy.length).toBeGreaterThan(160 * 1024);
    // Anonyme : refusé AVANT toute lecture du corps.
    await api().post(url(eventId, 'sync')).set('Content-Type', 'application/json').send(heavy).expect(401);
    await api().post(url(eventId, 'sync')).set(org.scanner.auth).set('Content-Type', 'application/json').send(heavy).expect(413);
    const ok = big(500);
    expect(ok.length).toBeLessThan(160 * 1024);
    await api().post(url(eventId, 'sync')).set(org.scanner.auth).set('Content-Type', 'application/json').send(ok).expect(200);
    await api().post('/api/v1/auth/login').set('Content-Type', 'application/json').send(JSON.stringify({ email: 'a@b.fr', password: 'x'.repeat(11_000) })).expect(413);
  });
});

describe('ordre « premier gagne » et idempotence (B6.1 M5 / tests)', () => {
  it('entre lots : un scan hors-ligne antérieur synchronisé APRÈS reçoit ALREADY_USED avec l’heure du premier passage', async () => {
    const { eventId, tickets } = await eventWithTickets(1);
    const t0 = Date.now() - 600_000;
    const first = await api().post(url(eventId, 'sync')).set(org.scanner.auth)
      .send({ deviceId: randomUUID(), scans: [{ scanId: randomUUID(), qrPayload: tickets[0]!.qrPayload, scannedAt: new Date(t0 + 60_000).toISOString() }] }).expect(200);
    const second = await api().post(url(eventId, 'sync')).set(org.scanner.auth)
      .send({ deviceId: randomUUID(), scans: [{ scanId: randomUUID(), qrPayload: tickets[0]!.qrPayload, scannedAt: new Date(t0).toISOString() }] }).expect(200);
    expect(first.body.results[0].result).toBe('ACCEPTED');
    expect(second.body.results[0]).toMatchObject({ result: 'ALREADY_USED', usedAt: new Date(t0 + 60_000).toISOString() });
  });

  it('scanId rejoué avec un AUTRE QR ⇒ résultat d’origine, sans effet ; scanId rejoué sur un autre événement ⇒ INVALID', async () => {
    const a = await eventWithTickets(2);
    const scanId = randomUUID();
    const first = await scan(a.eventId, a.tickets[0]!.qrPayload, scanId).expect(200);
    const replay = await scan(a.eventId, a.tickets[1]!.qrPayload, scanId).expect(200);
    expect(replay.body).toEqual(first.body);
    expect((await getDb().ticket.findFirstOrThrow({ where: { publicId: a.tickets[1]!.publicId } })).status).toBe('VALID');
    const b = await eventWithTickets(1);
    expect((await scan(b.eventId, b.tickets[0]!.qrPayload, scanId).expect(200)).body.result).toBe('INVALID');
    expect((await getDb().ticket.findFirstOrThrow({ where: { publicId: b.tickets[0]!.publicId } })).status).toBe('VALID');
  });
});

describe('clés de signature (B6.1 M4 / B3)', () => {
  function withKeys(files: { priv: string; pub: string }, env: Record<string, string> = {}) {
    const saved = { ...process.env };
    Object.assign(process.env, { TICKET_SIGNING_PRIVATE_KEY_FILE: files.priv, TICKET_SIGNING_PUBLIC_KEY_FILE: files.pub, ...env });
    resetEnvCache();
    resetTicketKeys();
    try {
      return loadTicketKeys();
    } finally {
      process.env = saved;
      resetEnvCache();
      resetTicketKeys();
    }
  }
  function writePair(mode = 0o600) {
    const dir = mkdtempSync(join(tmpdir(), 'nuits-k-'));
    const a = generateKeyPairSync('ed25519');
    const b = generateKeyPairSync('ed25519');
    const priv = join(dir, 'priv.pem');
    writeFileSync(priv, a.privateKey.export({ type: 'pkcs8', format: 'pem' }));
    chmodSync(priv, mode);
    const pub = join(dir, 'pub.pem');
    writeFileSync(pub, a.publicKey.export({ type: 'spki', format: 'pem' }));
    const other = join(dir, 'other.pem');
    writeFileSync(other, b.publicKey.export({ type: 'spki', format: 'pem' }));
    return { priv, pub, other };
  }

  it('paire dépareillée ⇒ refus de démarrer ; paire cohérente ⇒ OK', () => {
    const f = writePair();
    expect(() => withKeys({ priv: f.priv, pub: f.other })).toThrow(TicketKeyError);
    expect(() => withKeys({ priv: f.priv, pub: f.pub })).not.toThrow();
  });

  it('production : clé privée lisible par le groupe ou les autres ⇒ refus de démarrer', () => {
    const loose = writePair(0o644);
    const prod = { NODE_ENV: 'production', REFRESH_COOKIE_SECURE: 'true', AUTH_RESPONSE_FLOOR_MS: '400' };
    expect(() => withKeys({ priv: loose.priv, pub: loose.pub }, prod)).toThrow(/lisible/);
    const tight = writePair(0o400);
    expect(() => withKeys({ priv: tight.priv, pub: tight.pub }, prod)).not.toThrow();
  });
});
