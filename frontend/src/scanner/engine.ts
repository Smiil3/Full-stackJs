/**
 * Décision d'entrée (contrat v1.13).
 *
 * MODE PAR DÉFAUT — EN LIGNE : seule la réponse du serveur fait entrer. Réseau lent, 429 ou 5xx ⇒
 * réessais avec le MÊME scanId (backoff, budget ≈ 10 s) ; sans réponse ⇒ « Vérification impossible »,
 * personne n'entre. Aucune liste, aucune validation locale.
 *
 * MODE SECOURS HORS-LIGNE — seulement si l'événement a `offlineCheckinEnabled` et que la liste a été
 * préparée : après un court essai en ligne (≈ 3 s, un réessai rapide sur 429/5xx), décision locale
 * (signature Ed25519 + statut local) avec le même scanId, mise en file pour synchronisation.
 */
import { apiPath, apiRequest } from '../api/client';
import { isApiError } from '../api/errors';
import { serverNow } from '../api/serverClock';
import type { ScanResponse } from '../api/types';
import { abortTx, assertGeneration, currentGeneration, deviceId, getDeviceValue, getSnapshotMeta, purgeEvent, SCAN_LOCK, scannerDb, setDeviceValue, withLock } from './db';
import { trustedKeyFor } from './pinnedKey';
import { parseQr, verifySignature } from './verify';

/** Budget total d'une vérification en ligne (mode par défaut). */
export const ONLINE_BUDGET_MS = 10_000;
/** Mode secours : temps laissé au serveur avant de décider localement. */
export const RESCUE_ONLINE_BUDGET_MS = 3_000;
const BACKOFF_MS = [0, 400, 800, 1600, 3200];
const ATTEMPT_TIMEOUT_MS = 4_000;
/** Contrôle local refusé au-delà de la fin de l'événement + 24 h, ou avec une liste de plus de 24 h. */
const CLOSE_AFTER_END_MS = 24 * 3_600_000;
export const MAX_SNAPSHOT_AGE_MS = 24 * 3_600_000;
/** Recul d'horloge toléré (resynchronisation NTP) avant de refuser le contrôle local. */
const CLOCK_SKEW_MS = 2 * 60_000;
/** Horloge monotone de la page : ne recule jamais, même si l'heure de l'appareil est reculée. */
const MONO_WALL0 = Date.now();
const MONO_PERF0 = performance.now();
const monotonicWall = () => MONO_WALL0 + (performance.now() - MONO_PERF0);

type Holder = { ticketTypeName: string; holderInitials: string };
/** Pourquoi la décision a été prise localement (bandeau « mode dégradé »). */
export type LocalReason = 'offline' | 'network' | 'timeout' | 'server' | 'rate' | 'session';
type Mode = { offline: false } | { offline: true; reason: LocalReason };
export type ScanOutcome =
  | ({ kind: 'OK' } & Holder & Mode)
  | ({ kind: 'ALREADY_USED'; usedAt: string | null } & Partial<Holder> & Mode)
  | ({ kind: 'CANCELLED' } & Partial<Holder> & Mode)
  | ({ kind: 'INVALID' } & Mode)
  | ({ kind: 'WRONG_EVENT' } & Mode)
  /** Hors-ligne : billet authentique de cet événement mais absent de la liste ⇒ décision humaine. */
  | { kind: 'UNKNOWN_AUTHENTIC'; offline: true; reason: LocalReason; pending: PendingAdmission };

export type PendingAdmission = { orgId: string; eventId: string; qrPayload: string; scanId: string; publicId: string; owner: string };

// ---------------------------------------------------------------------------
// Erreurs (aucune ne fait entrer qui que ce soit)
// ---------------------------------------------------------------------------
export class VerificationImpossibleError extends Error {
  constructor(readonly scanId: string) {
    super('Vérification impossible');
  }
}
export class EventNotAvailableError extends Error {
  constructor() {
    super('Événement non disponible au contrôle');
  }
}
export class AccessRevokedError extends Error {
  constructor() {
    super('Accès au contrôle retiré');
  }
}
export class SessionExpiredError extends Error {
  constructor() {
    super('Session expirée');
  }
}
export class NoSnapshotError extends Error {
  constructor() {
    super('Aucune liste hors-ligne pour cet événement');
  }
}
export class EventClosedError extends Error {
  constructor() {
    super('Contrôle terminé pour cet événement');
  }
}
export class StaleSnapshotError extends Error {
  constructor() {
    super('Liste hors-ligne trop ancienne');
  }
}

export class ClockRollbackError extends Error {
  constructor() {
    super('Heure de l’appareil reculée');
  }
}

/**
 * « Maintenant » pour l'âge de la liste : jamais avant l'heure la plus avancée déjà observée (horloge
 * monotone de la page, téléchargement de la liste, plus haute heure enregistrée sur l'appareil).
 * Heure système nettement en arrière ⇒ quelqu'un a reculé l'horloge ⇒ contrôle local refusé.
 */
async function checkedLocalNow(savedAt: number): Promise<number> {
  const wall = Date.now();
  const stored = Date.parse((await getDeviceValue('clockHighWater')) ?? '') || 0;
  const highest = Math.max(stored, savedAt, monotonicWall());
  if (wall < highest - CLOCK_SKEW_MS) throw new ClockRollbackError();
  if (wall - stored > 60_000) await setDeviceValue('clockHighWater', new Date(wall).toISOString());
  return Math.max(wall, highest);
}

class TransientFailure extends Error {
  constructor(readonly reason: LocalReason) {
    super(reason);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function transientReason(e: unknown): LocalReason | null {
  if (!isApiError(e)) return null;
  if (e.code === 'NETWORK_ERROR') return 'network';
  if (e.code === 'TIMEOUT') return 'timeout';
  if (e.code === 'RATE_LIMITED') return 'rate';
  if (e.status >= 500) return 'server';
  return null;
}

/**
 * POST /checkin/scan avec réessais (MÊME scanId : le serveur renvoie le résultat d'origine si une
 * réponse s'est perdue). 401 : le client API a déjà tenté un refresh puis rejoué.
 */
async function postScan(orgId: string, eventId: string, qrPayload: string, scanId: string, budgetMs: number, onRetry?: () => void): Promise<ScanResponse> {
  const started = Date.now();
  const device = await deviceId();
  let last: LocalReason = 'network';
  for (let attempt = 0; attempt < BACKOFF_MS.length; attempt++) {
    const wait = BACKOFF_MS[attempt] ?? 0;
    if (wait > 0) {
      if (Date.now() - started + wait >= budgetMs) break;
      onRetry?.();
      await sleep(wait);
    }
    const remaining = budgetMs - (Date.now() - started);
    if (remaining <= 0) break;
    try {
      return await apiRequest<ScanResponse>(apiPath`/orgs/${orgId}/events/${eventId}/checkin/scan`, {
        method: 'POST',
        body: { qrPayload, deviceId: device, scanId },
        timeoutMs: Math.min(remaining, ATTEMPT_TIMEOUT_MS),
      });
    } catch (e) {
      if (isApiError(e) && e.status === 401) throw new SessionExpiredError();
      if (isApiError(e) && e.code === 'FORBIDDEN') {
        await purgeEvent(eventId).catch(() => undefined); // scanneur retiré : la liste locale part (la file reste)
        throw new AccessRevokedError();
      }
      if (isApiError(e) && e.code === 'NOT_FOUND') {
        // Contrôleur retiré du collectif (le serveur répond 404, pas 403) ou événement disparu.
        await purgeEvent(eventId).catch(() => undefined);
        throw new EventNotAvailableError();
      }
      if (isApiError(e) && e.code === 'VALIDATION_ERROR') return { result: 'INVALID', ticket: null, usedAt: null }; // QR trop long / mal formé
      const reason = transientReason(e);
      if (!reason) throw e;
      last = reason;
    }
  }
  throw new TransientFailure(last);
}

/** MODE PAR DÉFAUT : réponse du serveur obligatoire. `scanId` fourni pour un « Réessayer » du même passage. */
export async function scanOnline(args: { orgId: string; eventId: string; qrPayload: string; scanId?: string; onRetry?: () => void }): Promise<ScanOutcome> {
  const scanId = args.scanId ?? crypto.randomUUID();
  try {
    const res = await postScan(args.orgId, args.eventId, args.qrPayload.trim(), scanId, ONLINE_BUDGET_MS, args.onRetry);
    await reflectOnlineResult(args.eventId, res);
    return fromServer(res);
  } catch (e) {
    if (e instanceof TransientFailure) throw new VerificationImpossibleError(scanId);
    throw e;
  }
}

/** MODE SECOURS : court essai en ligne, puis décision locale avec le même scanId. */
export async function scanWithFallback(args: { orgId: string; eventId: string; qrPayload: string; online: boolean; owner: string }): Promise<ScanOutcome> {
  const scanId = crypto.randomUUID();
  const qrPayload = args.qrPayload.trim();
  let reason: LocalReason = 'offline';
  if (args.online) {
    try {
      const res = await postScan(args.orgId, args.eventId, qrPayload, scanId, RESCUE_ONLINE_BUDGET_MS);
      await reflectOnlineResult(args.eventId, res);
      return fromServer(res);
    } catch (e) {
      if (e instanceof TransientFailure) reason = e.reason;
      else if (e instanceof SessionExpiredError) reason = 'session';
      else throw e;
    }
  }
  return localScan({ orgId: args.orgId, eventId: args.eventId, qrPayload, scanId, owner: args.owner, reason });
}

function fromServer(res: ScanResponse): ScanOutcome {
  const holder = res.ticket ? { ticketTypeName: res.ticket.ticketTypeName, holderInitials: res.ticket.holderInitials } : {};
  switch (res.result) {
    case 'OK':
      return { kind: 'OK', offline: false, ticketTypeName: res.ticket?.ticketTypeName ?? '', holderInitials: res.ticket?.holderInitials ?? '' };
    case 'ALREADY_USED':
      return { kind: 'ALREADY_USED', offline: false, usedAt: res.usedAt, ...holder };
    case 'CANCELLED':
      return { kind: 'CANCELLED', offline: false, ...holder };
    case 'WRONG_EVENT':
      return { kind: 'WRONG_EVENT', offline: false };
    default:
      return { kind: 'INVALID', offline: false };
  }
}

/**
 * Le résultat en ligne met à jour la liste locale (mode secours) — mais le serveur FAIT FOI : un échec
 * d'IndexedDB (quota, navigation privée) n'empêche jamais d'afficher sa décision.
 */
async function reflectOnlineResult(eventId: string, res: ScanResponse): Promise<void> {
  if (!res.ticket || (res.result !== 'OK' && res.result !== 'ALREADY_USED' && res.result !== 'CANCELLED')) return;
  try {
    const db = await scannerDb();
    const existing = await db.get('tickets', [eventId, res.ticket.publicId]);
    if (!existing && !(await db.get('snapshots', eventId))) return; // pas de liste locale : rien à refléter
    await db.put('tickets', {
      eventId,
      publicId: res.ticket.publicId,
      ticketTypeName: res.ticket.ticketTypeName,
      holderInitials: res.ticket.holderInitials,
      status: res.result === 'CANCELLED' ? 'CANCELLED' : 'USED',
      usedAt: res.usedAt ?? existing?.usedAt ?? new Date(serverNow()).toISOString(),
      localOnly: false,
    });
  } catch {
    // Stockage local indisponible : sans effet sur la décision du serveur.
  }
}

/**
 * Vérification locale (mode secours). Sous verrou inter-onglets ; lecture + marquage + mise en file dans
 * UNE transaction qui revérifie la génération de session et la présence de la liste.
 */
export async function localScan(input: { orgId: string; eventId: string; qrPayload: string; scanId: string; owner: string; reason: LocalReason }): Promise<ScanOutcome> {
  // Identifiants normalisés en minuscules (URL saisie en majuscules ⇒ même événement que le QR).
  const args = { ...input, orgId: input.orgId.toLowerCase(), eventId: input.eventId.toLowerCase() };
  return withLock(SCAN_LOCK, async () => {
    const generation = await currentGeneration();
    const meta = await getSnapshotMeta(args.eventId);
    if (!meta) throw new NoSnapshotError();
    if (serverNow() > Date.parse(meta.endsAt) + CLOSE_AFTER_END_MS) throw new EventClosedError();
    const savedAt = Date.parse(meta.savedAt);
    if ((await checkedLocalNow(savedAt)) - savedAt > MAX_SNAPSHOT_AGE_MS) throw new StaleSnapshotError();
    const mode = { offline: true as const, reason: args.reason };
    const parsed = parseQr(args.qrPayload);
    if (!parsed || !(await verifySignature(parsed, trustedKeyFor(meta.publicKeyJwk)))) return { kind: 'INVALID', ...mode };
    if (parsed.eventId.toLowerCase() !== args.eventId) return { kind: 'WRONG_EVENT', ...mode };

    const db = await scannerDb();
    const tx = db.transaction(['device', 'snapshots', 'tickets', 'queue'], 'readwrite');
    await assertGeneration(tx, generation);
    if (!(await tx.objectStore('snapshots').get(args.eventId))) {
      abortTx(tx);
      throw new NoSnapshotError(); // liste purgée entre-temps
    }
    const tickets = tx.objectStore('tickets');
    const ticket = await tickets.get([args.eventId, parsed.publicId]);
    let outcome: ScanOutcome;
    if (!ticket) {
      outcome = { kind: 'UNKNOWN_AUTHENTIC', ...mode, pending: { orgId: args.orgId, eventId: args.eventId, qrPayload: args.qrPayload, scanId: args.scanId, publicId: parsed.publicId, owner: args.owner } };
    } else if (ticket.status === 'CANCELLED') {
      outcome = { kind: 'CANCELLED', ...mode, ticketTypeName: ticket.ticketTypeName, holderInitials: ticket.holderInitials };
    } else if (ticket.status === 'USED') {
      outcome = { kind: 'ALREADY_USED', ...mode, usedAt: ticket.usedAt, ticketTypeName: ticket.ticketTypeName, holderInitials: ticket.holderInitials };
    } else {
      const scannedAt = new Date(serverNow()).toISOString();
      await tickets.put({ ...ticket, status: 'USED', usedAt: scannedAt, localOnly: true });
      await tx.objectStore('queue').put({ scanId: args.scanId, eventId: args.eventId, orgId: args.orgId, qrPayload: args.qrPayload, scannedAt, ownerHash: args.owner, eventEndsAt: meta.endsAt });
      outcome = { kind: 'OK', ...mode, ticketTypeName: ticket.ticketTypeName, holderInitials: ticket.holderInitials };
    }
    await tx.done;
    return outcome;
  });
}

/**
 * « Laisser entrer » un billet authentique absent de la liste (vendu après sa préparation) : marqué
 * utilisé localement (2ᵉ présentation refusée) et mis en file. Mêmes garanties que localScan.
 */
export async function admitUnknown(p: PendingAdmission, reason: LocalReason): Promise<ScanOutcome> {
  return withLock(SCAN_LOCK, async () => {
    const generation = await currentGeneration();
    const db = await scannerDb();
    const tx = db.transaction(['device', 'snapshots', 'tickets', 'queue'], 'readwrite');
    await assertGeneration(tx, generation);
    const meta = await tx.objectStore('snapshots').get(p.eventId);
    if (!meta) {
      abortTx(tx);
      throw new NoSnapshotError();
    }
    if ((await tx.objectStore('tickets').get([p.eventId, p.publicId])) !== undefined) {
      await tx.done;
      return { kind: 'ALREADY_USED', offline: true, reason, usedAt: null }; // présenté entre-temps
    }
    const scannedAt = new Date(serverNow()).toISOString();
    await tx.objectStore('tickets').put({ eventId: p.eventId, publicId: p.publicId, ticketTypeName: 'Hors liste', holderInitials: '', status: 'USED', usedAt: scannedAt, localOnly: true });
    await tx.objectStore('queue').put({ scanId: p.scanId, eventId: p.eventId, orgId: p.orgId, qrPayload: p.qrPayload, scannedAt, ownerHash: p.owner, eventEndsAt: meta.endsAt });
    await tx.done;
    return { kind: 'OK', offline: true, reason, ticketTypeName: 'Hors liste', holderInitials: '' };
  });
}
