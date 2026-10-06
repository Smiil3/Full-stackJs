/**
 * Synchronisation de la file hors-ligne : POST /checkin/sync par lots de 500, résultats indexés par
 * scanId. ACCEPTED ⇒ retiré de la file ; autre résultat ⇒ conflit conservé pour affichage.
 * Une seule synchronisation à la fois par événement.
 */
import { apiPath, apiRequest } from '../api/client';
import type { SyncResponse } from '../api/types';
import { deviceId, listQueue, scannerDb, type SyncConflict } from './db';

const BATCH = 500;
/** Taille max d'un lot (contrat v1.12 : 160 ko côté serveur), avec marge. */
export const MAX_BATCH_BYTES = 150_000;

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
const inFlight = new Map<string, Promise<SyncReport>>();

export type SyncReport = { accepted: number; conflicts: number; remaining: number };

export function syncEvent(orgId: string, eventId: string): Promise<SyncReport> {
  const running = inFlight.get(eventId);
  if (running) return running;
  const p = doSync(orgId, eventId).finally(() => inFlight.delete(eventId));
  inFlight.set(eventId, p);
  return p;
}

async function doSync(orgId: string, eventId: string): Promise<SyncReport> {
  let accepted = 0;
  let conflicts = 0;
  const device = await deviceId();
  for (;;) {
    const batch = splitBatch((await listQueue(eventId)).filter((s) => s.orgId === orgId));
    if (batch.length === 0) break;
    const res = await apiRequest<SyncResponse>(apiPath`/orgs/${orgId}/events/${eventId}/checkin/sync`, {
      method: 'POST',
      body: { deviceId: device, scans: batch.map(({ scanId, qrPayload, scannedAt }) => ({ scanId, qrPayload, scannedAt })) },
      timeoutMs: 30_000,
    });
    const byId = new Map(batch.map((s) => [s.scanId, s]));
    const db = await scannerDb();
    const tx = db.transaction(['queue', 'tickets', 'conflicts'], 'readwrite');
    let handled = 0;
    for (const r of res.results) {
      const scan = byId.get(r.scanId);
      if (!scan) continue; // résultat inattendu : ignoré
      handled++;
      const publicId = scan.qrPayload.split('.')[2] ?? null;
      const ticket = publicId ? await tx.objectStore('tickets').get([eventId, publicId]) : undefined;
      if (r.result === 'ACCEPTED') {
        accepted++;
        if (ticket) await tx.objectStore('tickets').put({ ...ticket, status: 'USED', usedAt: r.usedAt ?? ticket.usedAt, localOnly: false });
      } else {
        conflicts++;
        const conflict: SyncConflict = {
          scanId: r.scanId,
          eventId,
          publicId,
          result: r.result,
          usedAt: r.usedAt,
          scannedAt: scan.scannedAt,
          ticketTypeName: ticket?.ticketTypeName ?? null,
          holderInitials: ticket?.holderInitials ?? null,
        };
        await tx.objectStore('conflicts').put(conflict);
        if (ticket && r.result === 'ALREADY_USED') await tx.objectStore('tickets').put({ ...ticket, status: 'USED', usedAt: r.usedAt ?? ticket.usedAt, localOnly: false });
        if (ticket && r.result === 'CANCELLED') await tx.objectStore('tickets').put({ ...ticket, status: 'CANCELLED', localOnly: false });
      }
      await tx.objectStore('queue').delete(r.scanId);
    }
    await tx.done;
    if (handled === 0) break; // le serveur n'a traité aucun scan du lot : on réessaiera plus tard
  }
  const remaining = (await listQueue(eventId)).length;
  return { accepted, conflicts, remaining };
}
