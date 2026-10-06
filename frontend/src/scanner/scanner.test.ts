import * as ed from '@noble/ed25519';
import { delay, http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { apiRequest, login, logout } from '../api/client';
import type { CheckinEvent, Order } from '../api/types';
import { runSessionCleanups } from '../auth/sessionCleanup';
import { injectFault, mock } from '../mocks/core';
import { markPaid } from '../mocks/domain';
import { server } from '../mocks/server';
import { DEMO_PASSWORD, IDS } from '../mocks/state';
import { bytesToBase64url } from '../lib/base64url';
import './cleanup';
import { deviceId, getLocalTicket, listConflicts, listQueue, listSnapshots, pendingCount, purgeEvent } from './db';
import { admitUnknown, localScan, scanTicket } from './engine';
import { prepareEvent } from './snapshot';
import { syncEvent } from './sync';
import { parseQr, verifyOptions, verifySignature } from './verify';

const ORG = IDS.orgNuits;
const EVENT: CheckinEvent = { id: IDS.eventConcert, title: 'Concert', venue: null, isOnline: false, startsAt: '', endsAt: '', timezone: 'Europe/Paris', status: 'PUBLISHED' };

/** Achète `qty` billets (acheteur), puis connecte le scanner. Renvoie les QR. */
async function ticketsFor(qty = 2): Promise<string[]> {
  await login('acheteur@example.test', DEMO_PASSWORD);
  const order = await apiRequest<Order>('/orders', {
    method: 'POST',
    body: { eventId: IDS.eventConcert, paymentMethod: 'CARD', items: [{ ticketTypeId: IDS.ttFosse, quantity: qty }] },
    headers: { 'Idempotency-Key': crypto.randomUUID() },
  });
  const stored = mock.db.orders.find((o) => o.id === order.id);
  if (stored) await markPaid(stored);
  await logout();
  await login('scanner@nuits.test', DEMO_PASSWORD);
  return mock.db.tickets.filter((t) => t.orderId === order.id).map((t) => t.qrPayload);
}

const scanArgs = (qrPayload: string) => ({ orgId: ORG, eventId: IDS.eventConcert, qrPayload, scanId: crypto.randomUUID() });

describe('vérification de signature Ed25519 (locale)', () => {
  async function signed(eventId: string, publicId: string) {
    const { secretKey, publicKey } = await ed.keygenAsync();
    const msg = `NG1.${eventId}.${publicId}`;
    const sig = await ed.signAsync(new TextEncoder().encode(msg), secretKey);
    return { payload: `${msg}.${bytesToBase64url(sig)}`, jwk: { kty: 'OKP' as const, crv: 'Ed25519' as const, x: bytesToBase64url(publicKey) } };
  }
  const EV = '0f0e0d0c-0b0a-4908-8706-050403020100';
  const PID = bytesToBase64url(new Uint8Array(16).fill(7));

  it.each([false, true])('signature valide acceptée, altérée refusée (repli logiciel : %s)', async (fallback) => {
    verifyOptions.forceFallback = fallback;
    const { payload, jwk } = await signed(EV, PID);
    const parsed = parseQr(payload);
    expect(parsed).not.toBeNull();
    expect(await verifySignature(parsed!, jwk)).toBe(true); // eslint-disable-line @typescript-eslint/no-non-null-assertion
    const otherPid = bytesToBase64url(new Uint8Array(16).fill(8));
    const forged = parseQr(payload.replace(PID, otherPid));
    expect(forged && (await verifySignature(forged, jwk))).toBe(false);
    const { jwk: otherKey } = await signed(EV, PID);
    expect(await verifySignature(parsed!, otherKey)).toBe(false); // eslint-disable-line @typescript-eslint/no-non-null-assertion
    verifyOptions.forceFallback = false;
  });

  it.each([
    'NG2.x.y.z',
    `NG1.${EV}.${PID}`,
    `NG1.${EV.toUpperCase()}.${PID}.${'A'.repeat(86)}`,
    `NG1.${EV}.short.${'A'.repeat(86)}`,
    `NG1.${EV}.${PID}.${'A'.repeat(85)}`,
    `NG1.${EV}.${PID}.${'A'.repeat(86)}.extra`,
    `NG1.${EV}.${PID}.${'+'.repeat(86)}`,
    'x'.repeat(300),
  ])('format refusé : %s', (payload) => {
    expect(parseQr(payload)).toBeNull();
  });

  it('clé publique mal formée ⇒ refus (jamais d’acceptation)', async () => {
    const { payload } = await signed(EV, PID);
    const parsed = parseQr(payload);
    expect(await verifySignature(parsed!, { kty: 'OKP', crv: 'Ed25519', x: 'abc' })).toBe(false); // eslint-disable-line @typescript-eslint/no-non-null-assertion
  });
});

describe('scanner hors-ligne', () => {
  it('snapshot : ne stocke que publicId, type, initiales, statut (+ clé publique) — ni email ni nom ni jeton', async () => {
    await ticketsFor(1);
    await prepareEvent(ORG, EVENT);
    const [meta] = await listSnapshots();
    expect(meta?.publicKeyJwk.kty).toBe('OKP');
    const t = mock.db.tickets[0];
    const local = await getLocalTicket(IDS.eventConcert, t?.publicId ?? '');
    expect(Object.keys(local ?? {}).sort()).toEqual(['eventId', 'holderInitials', 'publicId', 'status', 'ticketTypeName', 'usedAt']);
    expect(JSON.stringify(local)).not.toMatch(/@|Dupont|Jeanne|mock-at/);
  });

  it('OK puis DÉJÀ UTILISÉ au 2ᵉ passage local (même appareil, nouvelle tentative)', async () => {
    const [qr] = await ticketsFor(1);
    await prepareEvent(ORG, EVENT);
    const first = await localScan(scanArgs(qr ?? ''));
    expect(first).toMatchObject({ kind: 'OK', offline: true, ticketTypeName: 'Fosse', holderInitials: 'J.D.' });
    const second = await localScan(scanArgs(qr ?? ''));
    expect(second.kind).toBe('ALREADY_USED');
    expect(await pendingCount(IDS.eventConcert)).toBe(1);
  });

  it('double scan SIMULTANÉ ⇒ un seul OK (transaction IndexedDB)', async () => {
    const [qr] = await ticketsFor(1);
    await prepareEvent(ORG, EVENT);
    const results = await Promise.all([localScan(scanArgs(qr ?? '')), localScan(scanArgs(qr ?? '')), localScan(scanArgs(qr ?? ''))]);
    expect(results.filter((r) => r.kind === 'OK')).toHaveLength(1);
    expect(await pendingCount(IDS.eventConcert)).toBe(1);
  });

  it('signature falsifiée ⇒ INVALIDE ; autre événement ⇒ AUTRE ÉVÉNEMENT ; annulé ⇒ ANNULÉ', async () => {
    const [qr1, qr2] = await ticketsFor(2);
    await prepareEvent(ORG, EVENT);
    const tampered = (qr1 ?? '').slice(0, -3) + ((qr1 ?? '').endsWith('AAA') ? 'BBB' : 'AAA');
    expect((await localScan(scanArgs(tampered))).kind).toBe('INVALID');
    expect((await localScan(scanArgs('pas un billet'))).kind).toBe('INVALID');
    const { signQr } = await import('../mocks/crypto');
    const otherEvent = await signQr(IDS.eventSoldOut, bytesToBase64url(new Uint8Array(16).fill(1)));
    expect((await localScan(scanArgs(otherEvent))).kind).toBe('WRONG_EVENT');
    const publicId = (qr2 ?? '').split('.')[2] ?? '';
    const ticket = mock.db.tickets.find((t) => t.publicId === publicId);
    if (ticket) ticket.status = 'CANCELLED';
    await prepareEvent(ORG, EVENT); // snapshot rafraîchi
    expect((await localScan(scanArgs(qr2 ?? ''))).kind).toBe('CANCELLED');
  });

  it('billet authentique absent du snapshot ⇒ décision humaine ; « Laisser entrer » ⇒ file + refus au 2ᵉ passage', async () => {
    await ticketsFor(1);
    await prepareEvent(ORG, EVENT);
    const [late] = await ticketsFor(1); // vendu APRÈS le snapshot
    const r = await localScan(scanArgs(late ?? ''));
    expect(r.kind).toBe('UNKNOWN_AUTHENTIC');
    if (r.kind !== 'UNKNOWN_AUTHENTIC') return;
    expect(await pendingCount(IDS.eventConcert)).toBe(0); // rien tant que personne n'a décidé
    expect((await admitUnknown(r.pending)).kind).toBe('OK');
    expect(await pendingCount(IDS.eventConcert)).toBe(1);
    expect((await localScan(scanArgs(late ?? ''))).kind).toBe('ALREADY_USED');
  });

  it('en ligne : POST /checkin/scan ; délai de 3 s dépassé ⇒ vérif locale avec le MÊME scanId en file', async () => {
    const [qr1, qr2] = await ticketsFor(2);
    await prepareEvent(ORG, EVENT);
    const online = await scanTicket({ orgId: ORG, eventId: IDS.eventConcert, qrPayload: qr1 ?? '', online: true });
    expect(online).toMatchObject({ kind: 'OK', offline: false });
    let sentScanId = '';
    server.use(
      http.post('*/api/v1/orgs/:orgId/events/:eventId/checkin/scan', async ({ request }) => {
        sentScanId = ((await request.json()) as { scanId: string }).scanId;
        await delay(3500); // plus long que le délai de 3 s
        return HttpResponse.json({});
      }),
    );
    const slow = await scanTicket({ orgId: ORG, eventId: IDS.eventConcert, qrPayload: qr2 ?? '', online: true });
    expect(slow).toMatchObject({ kind: 'OK', offline: true });
    const queue = await listQueue(IDS.eventConcert);
    expect(queue.map((q) => q.scanId)).toEqual([sentScanId]);
  }, 10_000);

  it('coupure réseau ⇒ vérification locale ; synchro au retour : ACCEPTED retiré, conflit conservé', async () => {
    const [qr1, qr2] = await ticketsFor(2);
    await prepareEvent(ORG, EVENT);
    injectFault({ route: 'POST /orgs/:orgId/events/:eventId/checkin/scan', status: 0, code: 'INTERNAL_ERROR', network: true, times: 2 });
    expect((await scanTicket({ orgId: ORG, eventId: IDS.eventConcert, qrPayload: qr1 ?? '', online: true })).kind).toBe('OK');
    expect((await scanTicket({ orgId: ORG, eventId: IDS.eventConcert, qrPayload: qr2 ?? '', online: true })).kind).toBe('OK');
    // Entre-temps, une autre porte (en ligne) a déjà fait entrer le billet n°2.
    const publicId2 = (qr2 ?? '').split('.')[2] ?? '';
    const t2 = mock.db.tickets.find((t) => t.publicId === publicId2);
    if (t2) Object.assign(t2, { status: 'USED', usedAt: '2026-11-14T20:04:00.000Z' });
    const report = await syncEvent(ORG, IDS.eventConcert);
    expect(report).toEqual({ accepted: 1, conflicts: 1, remaining: 0 });
    const conflicts = await listConflicts(IDS.eventConcert);
    expect(conflicts[0]).toMatchObject({ result: 'ALREADY_USED', usedAt: '2026-11-14T20:04:00.000Z', publicId: publicId2 });
    expect((await getLocalTicket(IDS.eventConcert, publicId2))?.localOnly).toBe(false);
  });

  it('synchro idempotente : rejouer la même file ne crée aucun effet nouveau', async () => {
    const [qr] = await ticketsFor(1);
    await prepareEvent(ORG, EVENT);
    await localScan(scanArgs(qr ?? ''));
    const [queued] = await listQueue(IDS.eventConcert);
    await syncEvent(ORG, IDS.eventConcert);
    // la même requête rejouée (réponse perdue) : le serveur renvoie le résultat d'origine
    const res = await apiRequest<{ results: { result: string }[] }>(`/orgs/${ORG}/events/${IDS.eventConcert}/checkin/sync`, {
      method: 'POST',
      body: { deviceId: await deviceId(), scans: [{ scanId: queued?.scanId, qrPayload: queued?.qrPayload, scannedAt: queued?.scannedAt }] },
    });
    expect(res.results[0]?.result).toBe('ACCEPTED');
  });

  it('réseau absent pendant la synchro ⇒ file conservée', async () => {
    const [qr] = await ticketsFor(1);
    await prepareEvent(ORG, EVENT);
    await localScan(scanArgs(qr ?? ''));
    injectFault({ route: 'POST /orgs/:orgId/events/:eventId/checkin/sync', status: 0, code: 'INTERNAL_ERROR', network: true });
    await expect(syncEvent(ORG, IDS.eventConcert)).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    expect(await pendingCount(IDS.eventConcert)).toBe(1);
  });

  it('identifiant d’appareil stable ; purge à la déconnexion (sauf identifiant) et au changement d’événement', async () => {
    const [qr] = await ticketsFor(1);
    const id = await deviceId();
    expect(await deviceId()).toBe(id);
    await prepareEvent(ORG, EVENT);
    await localScan(scanArgs(qr ?? ''));
    await purgeEvent(IDS.eventConcert);
    expect(await listSnapshots()).toEqual([]);
    expect(await pendingCount()).toBe(0);
    await prepareEvent(ORG, EVENT);
    await localScan(scanArgs(qr ?? ''));
    await runSessionCleanups(); // déconnexion
    expect(await listSnapshots()).toEqual([]);
    expect(await pendingCount()).toBe(0);
    expect(await getLocalTicket(IDS.eventConcert, (qr ?? '').split('.')[2] ?? '')).toBeUndefined();
    expect(await deviceId()).toBe(id);
  });
});
