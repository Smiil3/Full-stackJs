import * as ed from '@noble/ed25519';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiRequest, login, logout } from '../api/client';
import type { CheckinEvent, Order, User } from '../api/types';
import { runSessionCleanups } from '../auth/sessionCleanup';
import { injectFault, mock } from '../mocks/core';
import { markPaid } from '../mocks/domain';
import { server } from '../mocks/server';
import { DEMO_PASSWORD, IDS } from '../mocks/state';
import { bytesToBase64url } from '../lib/base64url';
import { openCheckinWindow } from '../test/renderApp';
import './cleanup';
import {
  __wipeScannerForTests,
  currentGeneration,
  deviceId,
  getLocalTicket,
  getSnapshotMeta,
  listConflicts,
  listQueue,
  listSnapshots,
  ownerHash,
  pendingCount,
  purgeExpiredQueue,
  purgePersonal,
  scannerDb,
  SessionChangedError,
} from './db';
import {
  AccessRevokedError,
  admitUnknown,
  ClockRollbackError,
  EventClosedError,
  EventNotAvailableError,
  localScan,
  scanOnline,
  scanWithFallback,
  StaleSnapshotError,
  VerificationImpossibleError,
} from './engine';
import { OfflineDisabledError, prepareEvent } from './snapshot';
import { MAX_BATCH_BYTES, splitBatch, SyncForbiddenError, syncEvent } from './sync';
import { parseQr, verifyOptions, verifySignature } from './verify';

const ORG = IDS.orgNuits;
const EVENT: CheckinEvent = { id: IDS.eventConcert, title: 'Concert', venue: null, isOnline: false, startsAt: '', endsAt: new Date(Date.now() + 30 * 86_400_000).toISOString(), timezone: 'Europe/Paris', status: 'PUBLISHED', offlineCheckinEnabled: true };

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

let OWNER = '';
const scanArgs = (qrPayload: string) => ({ orgId: ORG, eventId: IDS.eventConcert, qrPayload, scanId: crypto.randomUUID(), owner: OWNER, reason: 'offline' as const });
const SCAN_ROUTE = 'POST /orgs/:orgId/events/:eventId/checkin/scan';

beforeEach(async () => {
  OWNER = await ownerHash(IDS.userScanner);
  await openCheckinWindow(IDS.eventConcert, IDS.eventSoldOut);
});
afterEach(async () => {
  await __wipeScannerForTests(); // y compris la file (conservée par la purge de fin de session)
});

describe('vérification de signature Ed25519 (locale)', () => {
  it('B4 : WebCrypto présent mais en échec (navigateur partiellement compatible) ⇒ bascule sur la vérification logicielle', async () => {
    const { secretKey, publicKey } = await ed.keygenAsync();
    const EVb = '0f0e0d0c-0b0a-4908-8706-050403020101';
    const PIDb = bytesToBase64url(new Uint8Array(16).fill(9));
    const msg = `NG1.${EVb}.${PIDb}`;
    const payload = `${msg}.${bytesToBase64url(await ed.signAsync(new TextEncoder().encode(msg), secretKey))}`;
    const spy = vi.spyOn(crypto.subtle, 'verify').mockRejectedValue(new DOMException('not supported', 'NotSupportedError'));
    const ok = await verifySignature(parseQr(payload)!, { kty: 'OKP', crv: 'Ed25519', x: bytesToBase64url(publicKey) }); // eslint-disable-line @typescript-eslint/no-non-null-assertion
    spy.mockRestore();
    expect(ok).toBe(true);
  });

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


describe('mode par défaut : EN LIGNE (contrat v1.13)', () => {
  it('réseau coupé ⇒ « Vérification impossible », personne n’entre, rien en file', async () => {
    const [qr] = await ticketsFor(1);
    injectFault({ route: SCAN_ROUTE, status: 0, code: 'INTERNAL_ERROR', network: true, times: 99 });
    await expect(scanOnline({ orgId: ORG, eventId: IDS.eventConcert, qrPayload: qr ?? '' })).rejects.toBeInstanceOf(VerificationImpossibleError);
    expect(await pendingCount()).toBe(0);
    expect(mock.db.tickets.find((t) => t.qrPayload === qr)?.status).toBe('VALID');
  }, 15_000);

  it('429 puis 200 ⇒ OK, avec UN SEUL scanId sur toutes les tentatives', async () => {
    const [qr] = await ticketsFor(1);
    const ids: string[] = [];
    server.use(
      http.post('*/api/v1/orgs/:orgId/events/:eventId/checkin/scan', async ({ request }) => {
        ids.push(((await request.clone().json()) as { scanId: string }).scanId);
        return undefined;
      }),
    );
    injectFault({ route: SCAN_ROUTE, status: 429, code: 'RATE_LIMITED', times: 1 });
    let retried = false;
    const r = await scanOnline({ orgId: ORG, eventId: IDS.eventConcert, qrPayload: qr ?? '', onRetry: () => (retried = true) });
    expect(r).toMatchObject({ kind: 'OK', offline: false });
    expect(retried).toBe(true);
    expect(ids.length).toBeGreaterThanOrEqual(2);
    expect(new Set(ids).size).toBe(1);
  });

  it('5xx répétés puis succès ⇒ OK (réessais dans le budget)', async () => {
    const [qr] = await ticketsFor(1);
    injectFault({ route: SCAN_ROUTE, status: 503, code: 'INTERNAL_ERROR', times: 2 });
    expect((await scanOnline({ orgId: ORG, eventId: IDS.eventConcert, qrPayload: qr ?? '' })).kind).toBe('OK');
  });

  it('réponse perdue (scan enregistré côté serveur) puis réessai ⇒ résultat d’ORIGINE (OK), pas « déjà utilisé »', async () => {
    const [qr] = await ticketsFor(1);
    let first = true;
    server.use(
      http.post('*/api/v1/orgs/:orgId/events/:eventId/checkin/scan', async ({ request }) => {
        if (!first) return undefined;
        first = false;
        // le serveur traite la requête…
        const body = (await request.clone().json()) as { qrPayload: string; scanId: string; deviceId: string };
        await apiRequest(`/orgs/${ORG}/events/${IDS.eventConcert}/checkin/scan`, { method: 'POST', body });
        // … mais la réponse se perd
        return HttpResponse.error();
      }),
    );
    const r = await scanOnline({ orgId: ORG, eventId: IDS.eventConcert, qrPayload: qr ?? '' });
    expect(r.kind).toBe('OK');
  });

  it('« Réessayer » après échec réutilise le même scanId', async () => {
    const [qr] = await ticketsFor(1);
    injectFault({ route: SCAN_ROUTE, status: 0, code: 'INTERNAL_ERROR', network: true, times: 99 });
    const err = await scanOnline({ orgId: ORG, eventId: IDS.eventConcert, qrPayload: qr ?? '' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VerificationImpossibleError);
    const { clearFaults } = await import('../mocks/core');
    clearFaults();
    const ids: string[] = [];
    server.use(
      http.post('*/api/v1/orgs/:orgId/events/:eventId/checkin/scan', async ({ request }) => {
        ids.push(((await request.clone().json()) as { scanId: string }).scanId);
        return undefined;
      }),
    );
    await scanOnline({ orgId: ORG, eventId: IDS.eventConcert, qrPayload: qr ?? '', scanId: (err as VerificationImpossibleError).scanId });
    expect(ids).toEqual([(err as VerificationImpossibleError).scanId]);
  }, 15_000);

  it('403 (contrôleur retiré) ⇒ erreur explicite et liste locale effacée ; 404 ⇒ événement non disponible', async () => {
    const [qr] = await ticketsFor(1);
    await prepareEvent(ORG, EVENT);
    injectFault({ route: SCAN_ROUTE, status: 403, code: 'FORBIDDEN' });
    await expect(scanOnline({ orgId: ORG, eventId: IDS.eventConcert, qrPayload: qr ?? '' })).rejects.toBeInstanceOf(AccessRevokedError);
    expect(await getSnapshotMeta(IDS.eventConcert)).toBeUndefined();
    injectFault({ route: SCAN_ROUTE, status: 404, code: 'NOT_FOUND' });
    await expect(scanOnline({ orgId: ORG, eventId: IDS.eventConcert, qrPayload: qr ?? '' })).rejects.toBeInstanceOf(EventNotAvailableError);
  });

  it('aucune liste ne peut être téléchargée si le mode secours n’est pas activé (409) ⇒ liste locale purgée', async () => {
    await ticketsFor(1);
    await prepareEvent(ORG, EVENT);
    const ev = mock.db.events.find((e) => e.id === IDS.eventConcert);
    if (ev) ev.offlineCheckinEnabled = false;
    await expect(prepareEvent(ORG, EVENT)).rejects.toBeInstanceOf(OfflineDisabledError);
    expect(await getSnapshotMeta(IDS.eventConcert)).toBeUndefined();
  });
});

describe('mode secours hors-ligne', () => {
  it('liste minimale : publicId, type, initiales, statut (+ clé publique) — ni email ni nom ni jeton', async () => {
    await ticketsFor(1);
    await prepareEvent(ORG, EVENT);
    const [meta] = await listSnapshots();
    expect(meta?.publicKeyJwk.kty).toBe('OKP');
    const local = await getLocalTicket(IDS.eventConcert, mock.db.tickets[0]?.publicId ?? '');
    expect(Object.keys(local ?? {}).sort()).toEqual(['eventId', 'holderInitials', 'localOnly', 'publicId', 'status', 'ticketTypeName', 'usedAt']);
    expect(JSON.stringify(local)).not.toMatch(/@|Dupont|Jeanne|mock-at/);
  });

  it('OK puis DÉJÀ UTILISÉ ; 3 lectures simultanées ⇒ un seul OK', async () => {
    const [qr1, qr2] = await ticketsFor(2);
    await prepareEvent(ORG, EVENT);
    expect(await localScan(scanArgs(qr1 ?? ''))).toMatchObject({ kind: 'OK', offline: true, ticketTypeName: 'Fosse', holderInitials: 'J.D.' });
    expect((await localScan(scanArgs(qr1 ?? ''))).kind).toBe('ALREADY_USED');
    const results = await Promise.all([localScan(scanArgs(qr2 ?? '')), localScan(scanArgs(qr2 ?? '')), localScan(scanArgs(qr2 ?? ''))]);
    expect(results.filter((r) => r.kind === 'OK')).toHaveLength(1);
    expect(await pendingCount(IDS.eventConcert)).toBe(2);
  });

  it('falsifié ⇒ INVALIDE ; autre événement ⇒ AUTRE ÉVÉNEMENT ; annulé ⇒ ANNULÉ', async () => {
    const [qr1, qr2] = await ticketsFor(2);
    await prepareEvent(ORG, EVENT);
    const tampered = (qr1 ?? '').slice(0, -3) + ((qr1 ?? '').endsWith('AAA') ? 'BBB' : 'AAA');
    expect((await localScan(scanArgs(tampered))).kind).toBe('INVALID');
    const { signQr } = await import('../mocks/crypto');
    expect((await localScan(scanArgs(await signQr(IDS.eventSoldOut, bytesToBase64url(new Uint8Array(16).fill(1)))))).kind).toBe('WRONG_EVENT');
    const t = mock.db.tickets.find((x) => x.qrPayload === qr2);
    if (t) t.status = 'CANCELLED';
    await prepareEvent(ORG, EVENT);
    expect((await localScan(scanArgs(qr2 ?? ''))).kind).toBe('CANCELLED');
  });

  it('billet absent de la liste ⇒ décision humaine ; « Laisser entrer » ⇒ file + refus au 2ᵉ passage', async () => {
    await ticketsFor(1);
    await prepareEvent(ORG, EVENT);
    const { signQr, randomPublicId } = await import('../mocks/crypto');
    const late = await signQr(IDS.eventConcert, randomPublicId());
    const r = await localScan(scanArgs(late));
    expect(r.kind).toBe('UNKNOWN_AUTHENTIC');
    if (r.kind !== 'UNKNOWN_AUTHENTIC') return;
    expect(await pendingCount()).toBe(0);
    expect((await admitUnknown(r.pending, 'offline')).kind).toBe('OK');
    expect((await localScan(scanArgs(late))).kind).toBe('ALREADY_USED');
    expect((await listQueue())[0]?.ownerHash).toBe(OWNER);
  });

  it('H2 : 429 puis 200 ⇒ décision du SERVEUR (pas de bascule locale) ; panne persistante ⇒ local avec la raison', async () => {
    const [qr1, qr2] = await ticketsFor(2);
    await prepareEvent(ORG, EVENT);
    injectFault({ route: SCAN_ROUTE, status: 429, code: 'RATE_LIMITED', times: 1 });
    expect(await scanWithFallback({ orgId: ORG, eventId: IDS.eventConcert, qrPayload: qr1 ?? '', online: true, owner: OWNER })).toMatchObject({ kind: 'OK', offline: false });
    injectFault({ route: SCAN_ROUTE, status: 503, code: 'INTERNAL_ERROR', times: 99 });
    expect(await scanWithFallback({ orgId: ORG, eventId: IDS.eventConcert, qrPayload: qr2 ?? '', online: true, owner: OWNER })).toMatchObject({ kind: 'OK', offline: true, reason: 'server' });
  }, 15_000);

  it('M4 : stockage local en échec après un OK du serveur ⇒ la décision du serveur est affichée', async () => {
    const [qr] = await ticketsFor(1);
    await prepareEvent(ORG, EVENT);
    const db = await scannerDb();
    const spy = vi.spyOn(db, 'put').mockRejectedValue(new Error('QuotaExceededError'));
    expect(await scanWithFallback({ orgId: ORG, eventId: IDS.eventConcert, qrPayload: qr ?? '', online: true, owner: OWNER })).toMatchObject({ kind: 'OK', offline: false });
    spy.mockRestore();
  });

  it('H3 : contrôle local refusé au-delà de la fin + 24 h, et avec une liste de plus de 24 h', async () => {
    const [qr] = await ticketsFor(1);
    await prepareEvent(ORG, { ...EVENT, endsAt: new Date(Date.now() - 25 * 3_600_000).toISOString() });
    await expect(localScan(scanArgs(qr ?? ''))).rejects.toBeInstanceOf(EventClosedError);
    await prepareEvent(ORG, EVENT);
    const db = await scannerDb();
    const meta = await db.get('snapshots', IDS.eventConcert);
    if (meta) await db.put('snapshots', { ...meta, savedAt: new Date(Date.now() - 25 * 3_600_000).toISOString() });
    await expect(localScan(scanArgs(qr ?? ''))).rejects.toBeInstanceOf(StaleSnapshotError);
  });

  it('F6-B4 : heure de l’appareil reculée ⇒ contrôle local refusé (âge de la liste non contournable)', async () => {
    const [qr1, qr2] = await ticketsFor(2);
    await prepareEvent(ORG, EVENT);
    expect((await localScan(scanArgs(qr1 ?? ''))).kind).toBe('OK');
    // Liste de 23 h selon l'appareil ; quelqu'un recule l'horloge de 3 h pour la « rajeunir ».
    const db = await scannerDb();
    const meta = await db.get('snapshots', IDS.eventConcert);
    const real = Date.now();
    if (meta) await db.put('snapshots', { ...meta, savedAt: new Date(real - 23 * 3_600_000).toISOString() });
    const now = vi.spyOn(Date, 'now').mockReturnValue(real - 3 * 3_600_000);
    try {
      await expect(localScan(scanArgs(qr2 ?? ''))).rejects.toBeInstanceOf(ClockRollbackError);
    } finally {
      now.mockRestore();
    }
    expect(await pendingCount()).toBe(1); // seul le premier passage est en file
  });

  it('M1 : mise à jour de la liste ⇒ un billet admis localement n’est jamais rétrogradé « valide »', async () => {
    const [qr] = await ticketsFor(1);
    await prepareEvent(ORG, EVENT);
    await localScan(scanArgs(qr ?? '')); // admis hors-ligne, pas encore transmis
    await prepareEvent(ORG, EVENT); // le serveur dit encore VALID
    expect((await localScan(scanArgs(qr ?? ''))).kind).toBe('ALREADY_USED');
  });

  it('M2 : fin de session pendant une opération ⇒ aucune écriture (génération)', async () => {
    const [qr] = await ticketsFor(1);
    await prepareEvent(ORG, EVENT);
    const gen = await currentGeneration();
    await purgePersonal();
    expect(await currentGeneration()).toBe(gen + 1);
    await expect(localScan(scanArgs(qr ?? ''))).rejects.toThrow(); // liste purgée : refus
    const { saveSnapshot } = await import('./db');
    await expect(saveSnapshot({ eventId: 'x', orgId: ORG, title: 't', timezone: 'UTC', endsAt: EVENT.endsAt, generatedAt: '', savedAt: '', publicKeyJwk: { kty: 'OKP', crv: 'Ed25519', x: 'a' }, ticketCount: 0 }, [], gen)).rejects.toBeInstanceOf(SessionChangedError);
  });
});

describe('identifiant d’événement en majuscules dans l’URL (audit, info)', () => {
  it('même événement écrit en majuscules ⇒ billet reconnu, pas « autre événement »', async () => {
    const [qr] = await ticketsFor(1);
    await prepareEvent(ORG, EVENT);
    const out = await localScan({ ...scanArgs(qr ?? ''), eventId: IDS.eventConcert.toUpperCase() });
    expect(out.kind).not.toBe('WRONG_EVENT');
  });
});

describe('clé publique épinglée (audit B14)', () => {
  afterEach(async () => {
    const { __setPinnedTicketKey } = await import('./pinnedKey');
    __setPinnedTicketKey(null);
  });

  it('liste signée par une autre clé que la clé épinglée ⇒ refusée, rien n’est enregistré', async () => {
    const { __setPinnedTicketKey, UntrustedKeyError } = await import('./pinnedKey');
    await ticketsFor(1);
    __setPinnedTicketKey({ kty: 'OKP', crv: 'Ed25519', x: 'BBBBxYmL0SJe6AbpQgVy6DOurnhSVLQv0CXQFgslXDE' });
    await expect(prepareEvent(ORG, EVENT)).rejects.toBeInstanceOf(UntrustedKeyError);
    expect(await getSnapshotMeta(IDS.eventConcert)).toBeUndefined();
  });

  it('clé remplacée dans IndexedDB ⇒ jamais utilisée : contrôle local refusé', async () => {
    const { __setPinnedTicketKey, UntrustedKeyError } = await import('./pinnedKey');
    const { mockPublicKeyJwk } = await import('../mocks/crypto');
    const [qr] = await ticketsFor(1);
    __setPinnedTicketKey(await mockPublicKeyJwk()); // clé réelle des billets
    await prepareEvent(ORG, EVENT);
    expect((await localScan(scanArgs(qr ?? ''))).kind).toBe('OK');
    const db = await scannerDb();
    const meta = await db.get('snapshots', IDS.eventConcert);
    if (meta) await db.put('snapshots', { ...meta, publicKeyJwk: { kty: 'OKP', crv: 'Ed25519', x: 'BBBBxYmL0SJe6AbpQgVy6DOurnhSVLQv0CXQFgslXDE' } });
    await expect(localScan(scanArgs(qr ?? ''))).rejects.toBeInstanceOf(UntrustedKeyError);
  });
});

describe('file de synchronisation (revue F4.1)', () => {
  it('H1 : fin de session ⇒ données personnelles purgées, FILE conservée ; même compte reconnecté ⇒ transmise', async () => {
    const [qr] = await ticketsFor(1);
    await prepareEvent(ORG, EVENT);
    await localScan(scanArgs(qr ?? ''));
    await runSessionCleanups(); // déconnexion / session expirée
    expect(await listSnapshots()).toEqual([]);
    expect(await getLocalTicket(IDS.eventConcert, (qr ?? '').split('.')[2] ?? '')).toBeUndefined();
    expect(await pendingCount()).toBe(1); // jamais perdue
    const report = await syncEvent(ORG, IDS.eventConcert, OWNER); // reconnexion du même compte
    expect(report).toMatchObject({ accepted: 1, remaining: 0 });
    expect(mock.db.tickets.find((t) => t.qrPayload === qr)?.status).toBe('USED');
  });

  it('H1 : la file d’un AUTRE compte n’est pas envoyée', async () => {
    const [qr] = await ticketsFor(1);
    await prepareEvent(ORG, EVENT);
    await localScan(scanArgs(qr ?? ''));
    const other = await ownerHash(IDS.userOwner);
    expect(await syncEvent(ORG, IDS.eventConcert, other)).toEqual({ accepted: 0, conflicts: 0, remaining: 0 });
    expect(await pendingCount(undefined, OWNER)).toBe(1);
  });

  it('H1 : purge automatique de la file à la fin de l’événement + 24 h', async () => {
    const [qr] = await ticketsFor(1);
    await prepareEvent(ORG, EVENT);
    await localScan(scanArgs(qr ?? ''));
    expect(await purgeExpiredQueue(Date.parse(EVENT.endsAt) + 23 * 3_600_000)).toBe(0);
    expect(await purgeExpiredQueue(Date.parse(EVENT.endsAt) + 25 * 3_600_000)).toBe(1);
  });

  it('ACCEPTED retiré, conflit conservé (non vu) ; rejeu idempotent par scanId', async () => {
    const [qr1, qr2] = await ticketsFor(2);
    await prepareEvent(ORG, EVENT);
    await localScan(scanArgs(qr1 ?? ''));
    await localScan(scanArgs(qr2 ?? ''));
    const t2 = mock.db.tickets.find((t) => t.qrPayload === qr2);
    if (t2) Object.assign(t2, { status: 'USED', usedAt: '2026-11-14T20:04:00.000Z' });
    const first = (await listQueue()).find((q) => q.qrPayload === qr1); // scan accepté (ordre des horodatages non garanti)
    expect(await syncEvent(ORG, IDS.eventConcert, OWNER)).toEqual({ accepted: 1, conflicts: 1, remaining: 0 });
    expect((await listConflicts(IDS.eventConcert))[0]).toMatchObject({ result: 'ALREADY_USED', seen: false });
    const replay = await apiRequest<{ results: { result: string }[] }>(`/orgs/${ORG}/events/${IDS.eventConcert}/checkin/sync`, {
      method: 'POST',
      body: { deviceId: await deviceId(), scans: [{ scanId: first?.scanId, qrPayload: first?.qrPayload, scannedAt: first?.scannedAt }] },
    });
    expect(replay.results[0]?.result).toBe('ACCEPTED'); // même scanId : résultat d'origine
  });

  it('réponse perdue après un passage local puis synchro avec le même scanId ⇒ ACCEPTED', async () => {
    const [qr] = await ticketsFor(1);
    await prepareEvent(ORG, EVENT);
    await localScan(scanArgs(qr ?? ''));
    const [queued] = await listQueue();
    // 1er envoi : traité par le serveur mais réponse perdue
    await apiRequest(`/orgs/${ORG}/events/${IDS.eventConcert}/checkin/sync`, { method: 'POST', body: { deviceId: await deviceId(), scans: [{ scanId: queued?.scanId, qrPayload: queued?.qrPayload, scannedAt: queued?.scannedAt }] } });
    expect(await syncEvent(ORG, IDS.eventConcert, OWNER)).toMatchObject({ accepted: 1, conflicts: 0 });
  });

  it('M3 : 403 en synchro ⇒ erreur avec le nombre de passages non confirmables, file conservée', async () => {
    const [qr] = await ticketsFor(1);
    await prepareEvent(ORG, EVENT);
    await localScan(scanArgs(qr ?? ''));
    injectFault({ route: 'POST /orgs/:orgId/events/:eventId/checkin/sync', status: 403, code: 'FORBIDDEN' });
    const err = await syncEvent(ORG, IDS.eventConcert, OWNER).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SyncForbiddenError);
    expect((err as SyncForbiddenError).pending).toBe(1);
    expect(await pendingCount()).toBe(1);
  });

  it('M5 : synchros simultanées (deux déclencheurs) ⇒ un seul envoi', async () => {
    const [qr] = await ticketsFor(1);
    await prepareEvent(ORG, EVENT);
    await localScan(scanArgs(qr ?? ''));
    const before = mock.db.calls.get('POST /orgs/:orgId/events/:eventId/checkin/sync') ?? 0;
    await Promise.all([syncEvent(ORG, IDS.eventConcert, OWNER), syncEvent(ORG, IDS.eventConcert, OWNER)]);
    expect((mock.db.calls.get('POST /orgs/:orgId/events/:eventId/checkin/sync') ?? 0) - before).toBe(1);
  });

  it('réseau absent pendant la synchro ⇒ file conservée', async () => {
    const [qr] = await ticketsFor(1);
    await prepareEvent(ORG, EVENT);
    await localScan(scanArgs(qr ?? ''));
    injectFault({ route: 'POST /orgs/:orgId/events/:eventId/checkin/sync', status: 0, code: 'INTERNAL_ERROR', network: true });
    await expect(syncEvent(ORG, IDS.eventConcert, OWNER)).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    expect(await pendingCount()).toBe(1);
  });

  it('F6-H2 : changement de compte pendant la synchro ⇒ aucun lot de X envoyé sous Y, file conservée', async () => {
    const db = await scannerDb();
    for (let i = 0; i < 501; i++) {
      await db.put('queue', { scanId: crypto.randomUUID(), eventId: IDS.eventConcert, orgId: ORG, qrPayload: `NG1.${IDS.eventConcert}.p${String(i)}.sig`, scannedAt: new Date().toISOString(), ownerHash: OWNER, eventEndsAt: EVENT.endsAt });
    }
    const auths: (string | null)[] = [];
    server.use(
      http.post('*/api/v1/orgs/:orgId/events/:eventId/checkin/sync', ({ request }) => {
        auths.push(request.headers.get('Authorization'));
        void login('acheteur@example.test', DEMO_PASSWORD); // un autre compte se connecte pendant l'envoi du 1er lot
        return HttpResponse.json({ results: [] });
      }),
    );
    await expect(syncEvent(ORG, IDS.eventConcert, OWNER)).rejects.toMatchObject({ code: 'SESSION_CHANGED' });
    expect(auths).toHaveLength(1); // 2e lot jamais envoyé
    expect(await pendingCount()).toBe(501);
  });

  it('F6-M4 : contrôleur retiré (404 au scan) ⇒ liste locale purgée, file conservée', async () => {
    const [qr1, qr2] = await ticketsFor(2);
    await prepareEvent(ORG, EVENT);
    await localScan(scanArgs(qr1 ?? ''));
    injectFault({ route: SCAN_ROUTE, status: 404, code: 'NOT_FOUND' });
    await expect(scanOnline({ orgId: ORG, eventId: IDS.eventConcert, qrPayload: qr2 ?? '' })).rejects.toBeInstanceOf(EventNotAvailableError);
    expect(await getSnapshotMeta(IDS.eventConcert)).toBeUndefined();
    expect(await pendingCount()).toBe(1);
  });

  it('F6-M4 : contrôleur retiré (404 à la synchro) ⇒ relances arrêtées, liste purgée, file conservée', async () => {
    const [qr] = await ticketsFor(1);
    await prepareEvent(ORG, EVENT);
    await localScan(scanArgs(qr ?? ''));
    injectFault({ route: 'POST /orgs/:orgId/events/:eventId/checkin/sync', status: 404, code: 'NOT_FOUND' });
    const err = await syncEvent(ORG, IDS.eventConcert, OWNER).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SyncForbiddenError);
    expect(await getSnapshotMeta(IDS.eventConcert)).toBeUndefined();
    expect(await pendingCount()).toBe(1);
  });

  it('F6-M4 : accès réécrits à chaque utilisateur reçu du serveur ; collectif retiré ⇒ ses listes purgées', async () => {
    await ticketsFor(1);
    await prepareEvent(ORG, EVENT);
    const { rememberScannerAccess } = await import('./access');
    const { getScannerAccess } = await import('./db');
    const me = await apiRequest<User>('/auth/me');
    const put = vi.spyOn(IDBObjectStore.prototype, 'put');
    await rememberScannerAccess(me);
    expect(await getScannerAccess()).toEqual({ ownerHash: OWNER, orgIds: [ORG] });
    expect(put).toHaveBeenCalled(); // l'espion voit bien les écritures
    put.mockClear();
    await rememberScannerAccess(me); // rien n'a changé : aucune écriture
    expect(put).not.toHaveBeenCalled();
    put.mockRestore();
    await rememberScannerAccess({ ...me, memberships: [] }); // retiré du collectif
    expect(await getScannerAccess()).toEqual({ ownerHash: OWNER, orgIds: [] });
    expect(await getSnapshotMeta(IDS.eventConcert)).toBeUndefined();
  });

  it('identifiant d’appareil stable', async () => {
    const id = await deviceId();
    expect(await deviceId()).toBe(id);
    await purgePersonal();
    expect(await deviceId()).toBe(id);
  });
});

describe('contrat v1.12', () => {
  it('lots de synchro ≤ 500 scans ET ≤ 150 ko sérialisés', () => {
    const scan = (i: number) => ({ scanId: crypto.randomUUID(), qrPayload: `NG1.${'e'.repeat(36)}.${'p'.repeat(22)}.${'s'.repeat(86)}`, scannedAt: new Date(i).toISOString() });
    const first = splitBatch(Array.from({ length: 1200 }, (_, i) => scan(i)));
    expect(first.length).toBeLessThanOrEqual(500);
    expect(new TextEncoder().encode(JSON.stringify({ deviceId: crypto.randomUUID(), scans: first })).length).toBeLessThanOrEqual(MAX_BATCH_BYTES + 100);
    const b = splitBatch(Array.from({ length: 100 }, (_, i) => ({ ...scan(i), qrPayload: 'x'.repeat(5000) })));
    expect(b.length).toBeGreaterThan(0);
    expect(b.length).toBeLessThan(100);
  });

  it('événement hors fenêtre de contrôle ⇒ « non disponible au contrôle » (préparation et scan)', async () => {
    await ticketsFor(1);
    const ev = mock.db.events.find((e) => e.id === IDS.eventConcert);
    if (ev) ev.endsAt = new Date(Date.now() - 25 * 3_600_000).toISOString();
    await expect(prepareEvent(ORG, EVENT)).rejects.toBeInstanceOf(EventNotAvailableError);
    await expect(scanOnline({ orgId: ORG, eventId: IDS.eventConcert, qrPayload: 'x' })).rejects.toBeInstanceOf(EventNotAvailableError);
  });

  it('événement annulé ⇒ résultat CANCELLED au scan en ligne', async () => {
    const [qr] = await ticketsFor(1);
    const ev = mock.db.events.find((e) => e.id === IDS.eventConcert);
    if (ev) ev.status = 'CANCELLED';
    expect((await scanOnline({ orgId: ORG, eventId: IDS.eventConcert, qrPayload: qr ?? '' })).kind).toBe('CANCELLED');
  });
});
