import { createPublicKey, generateKeyPairSync, randomUUID, sign, verify } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../../src/lib/db.js';
import { processOutboxBatch, type MailMessage } from '../../src/lib/outbox.js';
import { api, loggedInUser, type LoggedIn } from '../helpers.js';
import { createEvent, orgWithStaff, soonBody, type OrgFixture } from '../fixtures.js';

let org: OrgFixture;
let buyer: LoggedIn;

beforeEach(async () => {
  org = await orgWithStaff('collectif-scan');
  buyer = await loggedInUser({ email: 'spectateur@test.fr', displayName: 'Jean-Paul Dupont' });
});

/** Événement publié avec un type gratuit (billets émis immédiatement) et un acheteur qui a 2 billets. */
async function eventWithTickets(o: OrgFixture = org, who: LoggedIn = buyer, quantity = 2) {
  const { eventId, ticketTypeIds } = await createEvent(o, { body: soonBody(), ticketTypes: [{ name: 'Entrée', capacity: 50, priceCents: 0 }], publish: true });
  // Mode secours hors-ligne activé (snapshot) pour ces scénarios.
  await getDb().event.update({ where: { id: eventId }, data: { offlineCheckinEnabled: true } });
  await api().post('/api/v1/orders').set(who.auth).set('Idempotency-Key', randomUUID())
    .send({ eventId, paymentMethod: 'CARD', items: [{ ticketTypeId: ticketTypeIds[0]!, quantity }] }).expect(201);
  const tickets = await api().get('/api/v1/me/tickets').set(who.auth).expect(200);
  const mine = (tickets.body.items as { qrPayload: string; publicId: string; event: { id: string } }[]).filter((t) => t.event.id === eventId);
  return { eventId, tickets: mine };
}

const scanUrl = (o: OrgFixture, eventId: string, path: string) => `/api/v1/orgs/${o.id}/events/${eventId}/checkin/${path}`;
const scan = (o: OrgFixture, eventId: string, qrPayload: string, opts: { scanId?: string; deviceId?: string; as?: LoggedIn } = {}) =>
  api().post(scanUrl(o, eventId, 'scan')).set((opts.as ?? o.scanner).auth)
    .send({ qrPayload, deviceId: opts.deviceId ?? randomUUID(), scanId: opts.scanId ?? randomUUID() });

describe('billets de l’acheteur', () => {
  it('QR NG1.<eventId>.<publicId>.<signature Ed25519> vérifiable avec la clé publique, sans donnée personnelle', async () => {
    const { eventId, tickets } = await eventWithTickets();
    expect(tickets).toHaveLength(2);
    const snap = await api().get(scanUrl(org, eventId, 'snapshot')).set(org.scanner.auth).expect(200);
    const key = createPublicKey({ key: snap.body.publicKeyJwk as { kty: string; crv: string; x: string }, format: 'jwk' });
    for (const t of tickets) {
      const parts = t.qrPayload.split('.');
      expect(parts).toHaveLength(4);
      expect(parts[0]).toBe('NG1');
      expect(parts[1]).toBe(eventId);
      expect(parts[2]).toBe(t.publicId);
      expect(parts[2]).toMatch(/^[A-Za-z0-9_-]{22}$/);
      expect(parts[3]).toMatch(/^[A-Za-z0-9_-]{86}$/);
      expect(verify(null, Buffer.from(`NG1.${eventId}.${t.publicId}`), key, Buffer.from(parts[3]!, 'base64url'))).toBe(true);
      expect(t.qrPayload).not.toMatch(/spectateur|Dupont/);
    }
  });

  it('n’affiche que ses propres billets ; événements à venir puis passés', async () => {
    const past = await eventWithTickets(org, buyer, 1);
    await getDb().event.update({ where: { id: past.eventId }, data: { startsAt: new Date(Date.now() - 5 * 3600_000), endsAt: new Date(Date.now() - 3600_000), salesStartAt: new Date(Date.now() - 86400_000), salesEndAt: new Date(Date.now() - 2 * 3600_000) } });
    const upcoming = await eventWithTickets(org, buyer, 1);
    const res = await api().get('/api/v1/me/tickets').set(buyer.auth).expect(200);
    expect((res.body.items as { event: { id: string } }[]).map((t) => t.event.id)).toEqual([upcoming.eventId, past.eventId]);
    const other = await loggedInUser();
    const theirs = await api().get('/api/v1/me/tickets').set(other.auth).expect(200);
    expect(theirs.body.items).toEqual([]);
  });

  it('mail de confirmation : un QR PNG par billet en pièce jointe', async () => {
    await eventWithTickets(org, buyer, 2);
    const sent: MailMessage[] = [];
    await processOutboxBatch({ sendMail: (m: MailMessage) => { sent.push(m); return Promise.resolve(); } });
    const confirm = sent.find((m) => m.subject.startsWith('Vos billets'))!;
    expect(confirm.attachments).toHaveLength(2);
    expect(confirm.attachments![0]!.contentType).toBe('image/png');
    expect(confirm.attachments![0]!.content.subarray(1, 4).toString()).toBe('PNG');
  });
});

describe('scan en ligne', () => {
  it('premier passage OK, deuxième ALREADY_USED avec l’heure, même depuis le même appareil', async () => {
    const { eventId, tickets } = await eventWithTickets();
    const device = randomUUID();
    const first = await scan(org, eventId, tickets[0]!.qrPayload, { deviceId: device }).expect(200);
    expect(first.body).toEqual({ result: 'OK', ticket: { publicId: tickets[0]!.publicId, ticketTypeName: 'Entrée', holderInitials: 'J.P.D.' }, usedAt: expect.any(String) });
    const second = await scan(org, eventId, tickets[0]!.qrPayload, { deviceId: device }).expect(200);
    expect(second.body).toMatchObject({ result: 'ALREADY_USED', usedAt: first.body.usedAt });
    const view = await api().get('/api/v1/me/tickets').set(buyer.auth).expect(200);
    expect((view.body.items as { publicId: string; status: string }[]).find((t) => t.publicId === tickets[0]!.publicId)?.status).toBe('USED');
  });

  it('10 scans simultanés du même billet ⇒ exactement 1 OK', async () => {
    const { eventId, tickets } = await eventWithTickets();
    const results = await Promise.all(Array.from({ length: 10 }, () => scan(org, eventId, tickets[0]!.qrPayload)));
    const counts = results.reduce<Record<string, number>>((acc, r) => ({ ...acc, [r.body.result as string]: (acc[r.body.result as string] ?? 0) + 1 }), {});
    expect(counts).toEqual({ OK: 1, ALREADY_USED: 9 });
    expect(await getDb().checkIn.count({ where: { eventId } })).toBe(10);
  });

  it('scanId rejoué ⇒ résultat d’origine sans nouvel effet', async () => {
    const { eventId, tickets } = await eventWithTickets();
    const scanId = randomUUID();
    const first = await scan(org, eventId, tickets[0]!.qrPayload, { scanId }).expect(200);
    const replay = await scan(org, eventId, tickets[0]!.qrPayload, { scanId }).expect(200);
    expect(replay.body).toEqual(first.body);
    expect(await getDb().checkIn.count({ where: { scanId } })).toBe(1);
    // Rejoué en parallèle aussi.
    const id2 = randomUUID();
    const parallel = await Promise.all(Array.from({ length: 5 }, () => scan(org, eventId, tickets[1]!.qrPayload, { scanId: id2 })));
    expect(new Set(parallel.map((r) => r.body.result as string))).toEqual(new Set(['OK']));
  });

  it('QR falsifié ⇒ INVALID', async () => {
    const { eventId, tickets } = await eventWithTickets();
    const [prefix, ev, publicId, sig] = tickets[0]!.qrPayload.split('.') as [string, string, string, string];
    const other = tickets[1]!.publicId;
    const { privateKey } = generateKeyPairSync('ed25519');
    const forged = sign(null, Buffer.from(`NG1.${eventId}.${publicId}`), privateKey).toString('base64url');
    // Caractère de données altéré à coup sûr (l'ancienne version laissait la signature intacte si elle finissait par « BA »).
    const flipped = `${sig.slice(0, -2)}${sig.at(-2) === 'A' ? 'B' : 'A'}${sig.slice(-1)}`;
    for (const payload of [
      `${prefix}.${ev}.${other}.${sig}`, // signature d'un autre billet
      `${prefix}.${ev}.${publicId}.${forged}`, // signé avec une autre clé
      `${prefix}.${ev}.${publicId}.${flipped}`,
      `NG2.${ev}.${publicId}.${sig}`,
      `${prefix}.${ev}.${publicId}`,
      `${prefix}.${ev}.${publicId}.${sig}.x`,
      'n-importe-quoi',
    ]) {
      const res = await scan(org, eventId, payload).expect(200);
      expect(res.body, payload).toEqual({ result: 'INVALID', ticket: null, usedAt: null });
    }
    const t = await getDb().ticket.findFirstOrThrow({ where: { publicId } });
    expect(t.status).toBe('VALID');
  });

  it('billet d’un autre événement (même collectif ou autre) ⇒ WRONG_EVENT, sans effet', async () => {
    const a = await eventWithTickets();
    const b = await eventWithTickets();
    const res = await scan(org, a.eventId, b.tickets[0]!.qrPayload).expect(200);
    expect(res.body).toEqual({ result: 'WRONG_EVENT', ticket: null, usedAt: null });
    const otherOrg = await orgWithStaff('autre-collectif-scan');
    const c = await eventWithTickets(otherOrg, buyer, 1);
    expect((await scan(org, a.eventId, c.tickets[0]!.qrPayload).expect(200)).body.result).toBe('WRONG_EVENT');
    expect((await getDb().ticket.findFirstOrThrow({ where: { publicId: b.tickets[0]!.publicId } })).status).toBe('VALID');
  });

  it('SCANNER d’un autre collectif ⇒ 404 (scan, snapshot, sync) ; acheteur ⇒ 404', async () => {
    const { eventId, tickets } = await eventWithTickets();
    const otherOrg = await orgWithStaff('intrus-scan');
    await scan(org, eventId, tickets[0]!.qrPayload, { as: otherOrg.scanner }).expect(404);
    await api().get(scanUrl(org, eventId, 'snapshot')).set(otherOrg.scanner.auth).expect(404);
    await api().post(scanUrl(org, eventId, 'sync')).set(otherOrg.scanner.auth).send({ deviceId: randomUUID(), scans: [{ scanId: randomUUID(), qrPayload: tickets[0]!.qrPayload, scannedAt: new Date().toISOString() }] }).expect(404);
    // Via son propre collectif mais avec l'événement de l'autre : 404 aussi.
    await scan(otherOrg, eventId, tickets[0]!.qrPayload).expect(404);
    await scan(org, eventId, tickets[0]!.qrPayload, { as: buyer }).expect(404);
    expect((await getDb().ticket.findFirstOrThrow({ where: { publicId: tickets[0]!.publicId } })).status).toBe('VALID');
  });

  it('billet annulé ⇒ CANCELLED', async () => {
    const { eventId, tickets } = await eventWithTickets();
    await getDb().ticket.update({ where: { publicId: tickets[0]!.publicId }, data: { status: 'CANCELLED' } });
    const res = await scan(org, eventId, tickets[0]!.qrPayload).expect(200);
    expect(res.body).toMatchObject({ result: 'CANCELLED', usedAt: null });
  });
});

describe('snapshot hors-ligne', () => {
  it('clé publique + billets avec initiales seulement (aucun email ni nom complet)', async () => {
    const { eventId } = await eventWithTickets();
    const res = await api().get(scanUrl(org, eventId, 'snapshot')).set(org.scanner.auth).expect(200);
    expect(res.body.publicKeyJwk).toMatchObject({ kty: 'OKP', crv: 'Ed25519' });
    expect(res.body.tickets).toHaveLength(2);
    expect(res.body.tickets[0]).toEqual({ publicId: expect.any(String), ticketTypeName: 'Entrée', holderInitials: 'J.P.D.', status: 'VALID', usedAt: null });
    expect(JSON.stringify(res.body)).not.toMatch(/spectateur@|Dupont|Jean/);
  });
});

describe('synchronisation hors-ligne', () => {
  const sync = (eventId: string, scans: { scanId: string; qrPayload: string; scannedAt: string }[], deviceId = randomUUID()) =>
    api().post(scanUrl(org, eventId, 'sync')).set(org.scanner.auth).send({ deviceId, scans });

  it('conflit entre deux appareils : le premier scan (scannedAt) gagne, résultats indexés par scanId', async () => {
    const { eventId, tickets } = await eventWithTickets();
    const t0 = Date.now() - 60_000;
    const late = { scanId: randomUUID(), qrPayload: tickets[0]!.qrPayload, scannedAt: new Date(t0 + 5000).toISOString() };
    const early = { scanId: randomUUID(), qrPayload: tickets[0]!.qrPayload, scannedAt: new Date(t0).toISOString() };
    const res = await sync(eventId, [late, early]).expect(200);
    expect(res.body.results).toEqual([
      { scanId: late.scanId, result: 'ALREADY_USED', usedAt: new Date(t0).toISOString() },
      { scanId: early.scanId, result: 'ACCEPTED', usedAt: new Date(t0).toISOString() },
    ]);
    const checkIns = await getDb().checkIn.findMany({ where: { eventId } });
    expect(checkIns.every((c) => c.offline)).toBe(true);
  });

  it('un scan hors-ligne antérieur ne contourne pas un passage déjà enregistré', async () => {
    const { eventId, tickets } = await eventWithTickets();
    const online = await scan(org, eventId, tickets[0]!.qrPayload).expect(200);
    const res = await sync(eventId, [{ scanId: randomUUID(), qrPayload: tickets[0]!.qrPayload, scannedAt: new Date(Date.now() - 3600_000).toISOString() }]).expect(200);
    expect(res.body.results[0]).toMatchObject({ result: 'ALREADY_USED', usedAt: online.body.usedAt });
  });

  it('scanId d’un scan en ligne rejoué dans la synchro ⇒ ACCEPTED (résultat d’origine), sans effet', async () => {
    const { eventId, tickets } = await eventWithTickets();
    const scanId = randomUUID();
    await scan(org, eventId, tickets[0]!.qrPayload, { scanId }).expect(200);
    const res = await sync(eventId, [{ scanId, qrPayload: tickets[0]!.qrPayload, scannedAt: new Date().toISOString() }]).expect(200);
    expect(res.body.results[0]).toMatchObject({ scanId, result: 'ACCEPTED' });
    expect(await getDb().checkIn.count({ where: { scanId } })).toBe(1);
  });

  it('horodatage hors bornes ramené dans [début des ventes, maintenant + 5 min] et journalisé', async () => {
    const { eventId, tickets } = await eventWithTickets();
    const future = new Date(Date.now() + 86400_000);
    const ancient = new Date('2001-01-01T00:00:00Z');
    const a = { scanId: randomUUID(), qrPayload: tickets[0]!.qrPayload, scannedAt: future.toISOString() };
    const b = { scanId: randomUUID(), qrPayload: tickets[1]!.qrPayload, scannedAt: ancient.toISOString() };
    await sync(eventId, [a, b]).expect(200);
    const ca = await getDb().checkIn.findUniqueOrThrow({ where: { scanId: a.scanId } });
    expect(ca.scannedAtClamped).toBe(true);
    expect(ca.clientScannedAt!.getTime()).toBe(future.getTime());
    expect(ca.scannedAt.getTime()).toBeLessThanOrEqual(Date.now() + 5 * 60_000 + 1000);
    const cb = await getDb().checkIn.findUniqueOrThrow({ where: { scanId: b.scanId } });
    const event = await getDb().event.findUniqueOrThrow({ where: { id: eventId } });
    expect(cb.scannedAtClamped).toBe(true);
    expect(cb.scannedAt.getTime()).toBe(event.salesStartAt.getTime());
  });

  it('validation : 1 à 500 scans, scanId uniques', async () => {
    const { eventId, tickets } = await eventWithTickets();
    await sync(eventId, []).expect(400);
    const id = randomUUID();
    const s = { scanId: id, qrPayload: tickets[0]!.qrPayload, scannedAt: new Date().toISOString() };
    await sync(eventId, [s, s]).expect(400);
    await sync(eventId, Array.from({ length: 501 }, () => ({ ...s, scanId: randomUUID() }))).expect(400);
    // 500 scans : accepté (corps ~130 ko, limite dédiée à cette route).
    const ok = await sync(eventId, Array.from({ length: 500 }, () => ({ ...s, scanId: randomUUID() }))).expect(200);
    expect((ok.body.results as { result: string }[]).filter((r) => r.result === 'ACCEPTED')).toHaveLength(1);
  });
});
