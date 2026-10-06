/**
 * Stockage hors-ligne du scanner (IndexedDB). SEUL module autorisé (avec src/offline/) à utiliser IndexedDB.
 *
 * Données minimales (brief §3.10) : publicId, type de place, initiales, statut, clé publique.
 * PAS d'email, PAS de nom complet, PAS de jeton. S'y ajoutent les métadonnées non personnelles de
 * l'événement (titre, fuseau) et la file de scans à synchroniser.
 * ⚠ La file contient des `qrPayload` (justificatifs porteurs) : purgée avec le reste.
 */
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { PublicKeyJwk, TicketStatus } from '../api/types';

export type SnapshotMeta = {
  eventId: string;
  orgId: string;
  title: string;
  timezone: string;
  generatedAt: string;
  savedAt: string;
  publicKeyJwk: PublicKeyJwk;
  ticketCount: number;
};
export type LocalTicket = {
  eventId: string;
  publicId: string;
  ticketTypeName: string;
  holderInitials: string;
  status: TicketStatus;
  usedAt: string | null;
  /** true : admis hors-ligne par ce scanner, pas encore confirmé par le serveur. */
  localOnly?: boolean;
};
export type QueuedScan = { scanId: string; eventId: string; orgId: string; qrPayload: string; scannedAt: string };
export type SyncConflict = {
  scanId: string;
  eventId: string;
  publicId: string | null;
  result: 'ALREADY_USED' | 'INVALID' | 'CANCELLED' | 'WRONG_EVENT';
  usedAt: string | null;
  scannedAt: string;
  ticketTypeName: string | null;
  holderInitials: string | null;
};

interface ScannerDb extends DBSchema {
  device: { key: 'id'; value: string };
  snapshots: { key: string; value: SnapshotMeta };
  tickets: { key: [string, string]; value: LocalTicket; indexes: { byEvent: string } };
  queue: { key: string; value: QueuedScan; indexes: { byEvent: string } };
  conflicts: { key: string; value: SyncConflict; indexes: { byEvent: string } };
}

export type ScannerDB = IDBPDatabase<ScannerDb>;

export const scannerStorageAvailable = (): boolean => typeof indexedDB !== 'undefined';
const DB_NAME = 'nuits-scanner';
let dbPromise: Promise<ScannerDB> | null = null;

export function scannerDb(): Promise<ScannerDB> {
  if (typeof indexedDB === 'undefined') return Promise.reject(new Error('IndexedDB indisponible'));
  dbPromise ??= openDB<ScannerDb>(DB_NAME, 1, {
    upgrade(d) {
      d.createObjectStore('device');
      d.createObjectStore('snapshots', { keyPath: 'eventId' });
      d.createObjectStore('tickets', { keyPath: ['eventId', 'publicId'] }).createIndex('byEvent', 'eventId');
      d.createObjectStore('queue', { keyPath: 'scanId' }).createIndex('byEvent', 'eventId');
      d.createObjectStore('conflicts', { keyPath: 'scanId' }).createIndex('byEvent', 'eventId');
    },
  });
  return dbPromise;
}

/** Identifiant d'appareil : généré une seule fois, conservé (seule donnée persistée hors snapshot). */
export async function deviceId(): Promise<string> {
  const db = await scannerDb();
  const tx = db.transaction('device', 'readwrite');
  let id = await tx.store.get('id');
  if (!id) {
    id = crypto.randomUUID();
    await tx.store.put(id, 'id');
  }
  await tx.done;
  return id;
}

export async function getSnapshotMeta(eventId: string): Promise<SnapshotMeta | undefined> {
  return (await scannerDb()).get('snapshots', eventId);
}

export async function listSnapshots(): Promise<SnapshotMeta[]> {
  return (await scannerDb()).getAll('snapshots');
}

/**
 * Remplace le snapshot d'un événement. Les billets admis hors-ligne et pas encore synchronisés
 * restent marqués « utilisés » (le serveur ne le sait pas encore).
 */
export async function saveSnapshot(meta: SnapshotMeta, tickets: LocalTicket[]): Promise<void> {
  const db = await scannerDb();
  const tx = db.transaction(['snapshots', 'tickets', 'queue'], 'readwrite');
  const pending = new Set<string>();
  const local = await tx.objectStore('tickets').index('byEvent').getAll(meta.eventId);
  for (const t of local) if (t.localOnly) pending.add(t.publicId);
  const queued = await tx.objectStore('queue').index('byEvent').count(meta.eventId);
  let cursor = await tx.objectStore('tickets').index('byEvent').openCursor(meta.eventId);
  while (cursor) {
    if (!(queued > 0 && cursor.value.localOnly)) await cursor.delete();
    cursor = await cursor.continue();
  }
  for (const t of tickets) {
    if (queued > 0 && pending.has(t.publicId) && t.status === 'VALID') continue;
    await tx.objectStore('tickets').put(t);
  }
  await tx.objectStore('snapshots').put(meta);
  await tx.done;
}

export async function getLocalTicket(eventId: string, publicId: string): Promise<LocalTicket | undefined> {
  return (await scannerDb()).get('tickets', [eventId, publicId]);
}

export async function pendingCount(eventId?: string): Promise<number> {
  const db = await scannerDb();
  return eventId ? db.countFromIndex('queue', 'byEvent', eventId) : db.count('queue');
}

export async function listQueue(eventId: string): Promise<QueuedScan[]> {
  const all = await (await scannerDb()).getAllFromIndex('queue', 'byEvent', eventId);
  return all.sort((a, b) => a.scannedAt.localeCompare(b.scannedAt));
}

export async function listConflicts(eventId: string): Promise<SyncConflict[]> {
  const all = await (await scannerDb()).getAllFromIndex('conflicts', 'byEvent', eventId);
  return all.sort((a, b) => b.scannedAt.localeCompare(a.scannedAt));
}

/** Purge TOUTES les données d'un événement (snapshot, billets, file, conflits). */
export async function purgeEvent(eventId: string): Promise<void> {
  const db = await scannerDb();
  const tx = db.transaction(['snapshots', 'tickets', 'queue', 'conflicts'], 'readwrite');
  await tx.objectStore('snapshots').delete(eventId);
  for (const store of ['tickets', 'queue', 'conflicts'] as const) {
    let c = await tx.objectStore(store).index('byEvent').openCursor(eventId);
    while (c) {
      await c.delete();
      c = await c.continue();
    }
  }
  await tx.done;
}

/** Purge complète (déconnexion), sauf l'identifiant d'appareil. */
export async function purgeAll(): Promise<void> {
  const db = await scannerDb();
  const tx = db.transaction(['snapshots', 'tickets', 'queue', 'conflicts'], 'readwrite');
  await Promise.all([tx.objectStore('snapshots').clear(), tx.objectStore('tickets').clear(), tx.objectStore('queue').clear(), tx.objectStore('conflicts').clear()]);
  await tx.done;
}
