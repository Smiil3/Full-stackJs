/**
 * Synchronisation de la file : POST /checkin/sync par lots (≤ 500 scans, ≤ 150 ko), résultats indexés
 * par scanId. Une seule synchro à la fois (onglet ET appareil : Web Lock). Seuls les scans du compte
 * connecté (empreinte) et du collectif sont envoyés. ACCEPTED ⇒ retiré ; autre résultat ⇒ conflit.
 */
import { apiPath, apiRequest } from '../api/client';
import { isApiError } from '../api/errors';
import type { SyncResponse } from '../api/types';
import { currentGeneration, deviceId, listQueue, scannerDb, withLock, type SyncConflict } from './db';

const BATCH = 500;
/** Taille max d'un lot (contrat v1.12 : 160 ko côté serveur), avec marge. */
export const MAX_BATCH_BYTES = 150_000;
const inFlight = new Map<string, Promise<SyncReport>>();

export type SyncReport = { accepted: number; conflicts: number; remaining: number };

/** Le serveur refuse la synchro (droits retirés) : relances arrêtées, consigne affichée. */
export class SyncForbiddenError extends Error {
  constructor(readonly pending: number) {
    super('Synchronisation refusée');
  }
}

/** Découpe en lots de ≤ 500 scans ET ≤ MAX_BATCH_BYTES une fois sérialisés. */
export function splitBatch<T>(scans: T[], maxBytes = MAX_BATCH_BYTES): T[] {
  const out: T[] = [];
  let size = 64; // enveloppe JSON { deviceId, scans: [] }
  for (const s of scans) {
    const len = new TextEncoder().encode(JSON.stringify(s)).length + 1;
    if (out.length >= BATCH || (out.length > 0 && size + len > maxBytes)) break;
    out.push(s);
    size += len;
  }
  return out;
}

export function syncEvent(orgId: string, eventId: string, owner: string): Promise<SyncReport> {
  const key = `${orgId}:${eventId}:${owner}`;
  const running = inFlight.get(key);
  if (running) return running;
  const p = withLock(`nuits-sync-${eventId}`, () => doSync(orgId, eventId, owner)).finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p;
}

async function doSync(orgId: string, eventId: string, owner: string): Promise<SyncReport> {
  let accepted = 0;
  let conflicts = 0;
  const device = await deviceId();
  const mine = async () => (await listQueue(eventId)).filter((s) => s.orgId === orgId && s.ownerHash === owner);
  for (;;) {
    const batch = splitBatch(await mine());
    if (batch.length === 0) break;
    let res: SyncResponse;
    try {
      res = await apiRequest<SyncResponse>(apiPath`/orgs/${orgId}/events/${eventId}/checkin/sync`, {
        method: 'POST',
        body: { deviceId: device, scans: batch.map(({ scanId, qrPayload, scannedAt }) => ({ scanId, qrPayload, scannedAt })) },
        timeoutMs: 30_000,
      });
    } catch (e) {
      if (isApiError(e) && e.code === 'FORBIDDEN') throw new SyncForbiddenError((await mine()).length);
      throw e;
    }
    const generation = await currentGeneration();
    const byId = new Map(batch.map((s) => [s.scanId, s]));
    const db = await scannerDb();
    const tx = db.transaction(['device', 'queue', 'tickets', 'conflicts'], 'readwrite');
    const g = await tx.objectStore('device').get('gen');
    // Session terminée pendant l'envoi : on retire de la file ce que le serveur a traité, sans écrire
    // de données personnelles (conflits, liste).
    const sameSession = (typeof g === 'number' ? g : 0) === generation;
    let handled = 0;
    for (const r of res.results) {
      const scan = byId.get(r.scanId);
      if (!scan) continue;
      handled++;
      const publicId = scan.qrPayload.split('.')[2] ?? null;
      const ticket = sameSession && publicId ? await tx.objectStore('tickets').get([eventId, publicId]) : undefined;
      if (r.result === 'ACCEPTED') {
        accepted++;
        if (ticket) await tx.objectStore('tickets').put({ ...ticket, status: 'USED', usedAt: r.usedAt ?? ticket.usedAt, localOnly: false });
      } else {
        conflicts++;
        if (sameSession) {
          const conflict: SyncConflict = {
            scanId: r.scanId,
            eventId,
            publicId,
            result: r.result,
            usedAt: r.usedAt,
            scannedAt: scan.scannedAt,
            ticketTypeName: ticket?.ticketTypeName ?? null,
            holderInitials: ticket?.holderInitials ?? null,
            seen: false,
          };
          await tx.objectStore('conflicts').put(conflict);
        }
        if (ticket && r.result === 'ALREADY_USED') await tx.objectStore('tickets').put({ ...ticket, status: 'USED', usedAt: r.usedAt ?? ticket.usedAt, localOnly: false });
        if (ticket && r.result === 'CANCELLED') await tx.objectStore('tickets').put({ ...ticket, status: 'CANCELLED', localOnly: false });
      }
      await tx.objectStore('queue').delete(r.scanId);
    }
    await tx.done;
    if (handled === 0) break; // aucun scan du lot traité : nouvel essai plus tard
  }
  return { accepted, conflicts, remaining: (await mine()).length };
}
