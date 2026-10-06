/**
 * Décision d'entrée. En ligne : POST /checkin/scan (délai max 3 s). Hors-ligne ou délai dépassé :
 * vérification de la signature + statut local, marquage local et file de synchronisation —
 * AVEC LE MÊME scanId (idempotence serveur, contrat v1.1).
 */
import { apiPath, apiRequest } from '../api/client';
import { isApiError } from '../api/errors';
import { serverNow } from '../api/serverClock';
import type { ScanResponse } from '../api/types';
import { deviceId, getSnapshotMeta, scannerDb } from './db';
import { parseQr, verifySignature } from './verify';

export const ONLINE_SCAN_TIMEOUT_MS = 3000;

type Holder = { ticketTypeName: string; holderInitials: string };
export type ScanOutcome =
  | ({ kind: 'OK'; offline: boolean } & Holder)
  | ({ kind: 'ALREADY_USED'; offline: boolean; usedAt: string | null } & Partial<Holder>)
  | ({ kind: 'CANCELLED'; offline: boolean } & Partial<Holder>)
  | { kind: 'INVALID'; offline: boolean }
  | { kind: 'WRONG_EVENT'; offline: boolean }
  /** Hors-ligne : billet authentique de cet événement mais absent du snapshot ⇒ décision humaine. */
  | { kind: 'UNKNOWN_AUTHENTIC'; offline: true; pending: PendingAdmission };

export type PendingAdmission = { orgId: string; eventId: string; qrPayload: string; scanId: string; publicId: string };

export class NoSnapshotError extends Error {
  constructor() {
    super('Aucune liste hors-ligne pour cet événement');
  }
}

/** Erreurs pour lesquelles on bascule en vérification locale (réseau, délai, serveur, session perdue). */
function shouldFallBack(e: unknown): boolean {
  if (!isApiError(e)) return false;
  return e.code === 'NETWORK_ERROR' || e.code === 'TIMEOUT' || e.status >= 500 || e.status === 401 || e.code === 'RATE_LIMITED';
}

export async function scanTicket(args: { orgId: string; eventId: string; qrPayload: string; online: boolean }): Promise<ScanOutcome> {
  const scanId = crypto.randomUUID();
  const qrPayload = args.qrPayload.trim();
  if (args.online) {
    try {
      const res = await apiRequest<ScanResponse>(apiPath`/orgs/${args.orgId}/events/${args.eventId}/checkin/scan`, {
        method: 'POST',
        body: { qrPayload, deviceId: await deviceId(), scanId },
        timeoutMs: ONLINE_SCAN_TIMEOUT_MS,
      });
      await reflectOnlineResult(args.eventId, res);
      return fromServer(res);
    } catch (e) {
      if (!shouldFallBack(e)) throw e;
    }
  }
  return localScan({ ...args, qrPayload, scanId });
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

/** Le résultat en ligne met à jour la copie locale (utile si le réseau tombe juste après). */
async function reflectOnlineResult(eventId: string, res: ScanResponse): Promise<void> {
  if (!res.ticket || (res.result !== 'OK' && res.result !== 'ALREADY_USED' && res.result !== 'CANCELLED')) return;
  const db = await scannerDb();
  const existing = await db.get('tickets', [eventId, res.ticket.publicId]);
  await db.put('tickets', {
    eventId,
    publicId: res.ticket.publicId,
    ticketTypeName: res.ticket.ticketTypeName,
    holderInitials: res.ticket.holderInitials,
    status: res.result === 'CANCELLED' ? 'CANCELLED' : 'USED',
    usedAt: res.usedAt ?? existing?.usedAt ?? new Date(serverNow()).toISOString(),
    localOnly: false,
  });
}

/** Vérification hors-ligne. La lecture + le marquage se font dans UNE transaction (pas de double entrée). */
export async function localScan(args: { orgId: string; eventId: string; qrPayload: string; scanId: string }): Promise<ScanOutcome> {
  const meta = await getSnapshotMeta(args.eventId);
  if (!meta) throw new NoSnapshotError();
  const parsed = parseQr(args.qrPayload);
  if (!parsed || !(await verifySignature(parsed, meta.publicKeyJwk))) return { kind: 'INVALID', offline: true };
  if (parsed.eventId !== args.eventId) return { kind: 'WRONG_EVENT', offline: true };

  const db = await scannerDb();
  const tx = db.transaction(['tickets', 'queue'], 'readwrite');
  const tickets = tx.objectStore('tickets');
  const ticket = await tickets.get([args.eventId, parsed.publicId]);
  let outcome: ScanOutcome;
  if (!ticket) {
    outcome = { kind: 'UNKNOWN_AUTHENTIC', offline: true, pending: { ...args, publicId: parsed.publicId } };
  } else if (ticket.status === 'CANCELLED') {
    outcome = { kind: 'CANCELLED', offline: true, ticketTypeName: ticket.ticketTypeName, holderInitials: ticket.holderInitials };
  } else if (ticket.status === 'USED') {
    outcome = { kind: 'ALREADY_USED', offline: true, usedAt: ticket.usedAt, ticketTypeName: ticket.ticketTypeName, holderInitials: ticket.holderInitials };
  } else {
    const scannedAt = new Date(serverNow()).toISOString();
    await tickets.put({ ...ticket, status: 'USED', usedAt: scannedAt, localOnly: true });
    await tx.objectStore('queue').put({ scanId: args.scanId, eventId: args.eventId, orgId: args.orgId, qrPayload: args.qrPayload, scannedAt });
    outcome = { kind: 'OK', offline: true, ticketTypeName: ticket.ticketTypeName, holderInitials: ticket.holderInitials };
  }
  await tx.done;
  return outcome;
}

/**
 * « Laisser entrer » un billet authentique absent de la liste (vendu après le snapshot) :
 * marqué utilisé localement (pour refuser une 2ᵉ présentation) et mis en file de synchronisation.
 */
export async function admitUnknown(p: PendingAdmission): Promise<ScanOutcome> {
  const db = await scannerDb();
  const tx = db.transaction(['tickets', 'queue'], 'readwrite');
  const existing = await tx.objectStore('tickets').get([p.eventId, p.publicId]);
  if (existing) {
    await tx.done;
    return localScan(p); // présenté entre-temps : décision normale
  }
  const scannedAt = new Date(serverNow()).toISOString();
  await tx.objectStore('tickets').put({ eventId: p.eventId, publicId: p.publicId, ticketTypeName: 'Hors liste', holderInitials: '', status: 'USED', usedAt: scannedAt, localOnly: true });
  await tx.objectStore('queue').put({ scanId: p.scanId, eventId: p.eventId, orgId: p.orgId, qrPayload: p.qrPayload, scannedAt });
  await tx.done;
  return { kind: 'OK', offline: true, ticketTypeName: 'Hors liste', holderInitials: '' };
}
