/**
 * Stockage hors-ligne du scanner (IndexedDB). SEUL module autorisé (avec src/offline/) à utiliser IndexedDB.
 *
 * Deux catégories de données, au cycle de vie DIFFÉRENT (décision PO, revue F4.1) :
 * - données PERSONNELLES / liées à la session : liste de l'événement (publicId, type, initiales,
 *   statut, clé publique), conflits (initiales), accès connus ⇒ purgées à chaque fin de session ;
 * - FILE de synchronisation (scanId, qrPayload, scannedAt, orgId, eventId, empreinte du compte) ⇒
 *   JAMAIS purgée tant qu'elle n'est pas transmise (sinon un billet admis hors-ligne redeviendrait
 *   utilisable à une autre porte). Seule exception : purge automatique à la fin de l'événement + 24 h.
 *
 * Chaque écriture liée à une session vérifie un numéro de GÉNÉRATION (incrémenté à chaque purge) :
 * une opération commencée avant une déconnexion n'écrit rien après.
 * Pas d'email, pas de nom complet, pas de jeton.
 */
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { PublicKeyJwk, TicketStatus } from '../api/types';

export type SnapshotMeta = {
  eventId: string;
  orgId: string;
  title: string;
  timezone: string;
  /** Fin de l'événement : le contrôle local est refusé au-delà de endsAt + 24 h. */
  endsAt: string;
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
export type QueuedScan = {
  scanId: string;
  eventId: string;
  orgId: string;
  qrPayload: string;
  scannedAt: string;
  /** Empreinte SHA-256 du compte qui a scanné : seule CETTE personne peut transmettre la file. */
  ownerHash: string;
  /** Purge automatique de la file à eventEndsAt + 24 h. */
  eventEndsAt: string;
};
export type SyncConflict = {
  scanId: string;
  eventId: string;
  publicId: string | null;
  result: 'ALREADY_USED' | 'INVALID' | 'CANCELLED' | 'WRONG_EVENT';
  usedAt: string | null;
  scannedAt: string;
  ticketTypeName: string | null;
  holderInitials: string | null;
  seen: boolean;
};
export type ScannerAccess = { ownerHash: string; orgIds: string[] };

type DeviceValue = string | number | ScannerAccess;
interface ScannerDb extends DBSchema {
  device: { key: string; value: DeviceValue };
  snapshots: { key: string; value: SnapshotMeta };
  tickets: { key: [string, string]; value: LocalTicket; indexes: { byEvent: string } };
  queue: { key: string; value: QueuedScan; indexes: { byEvent: string } };
  conflicts: { key: string; value: SyncConflict; indexes: { byEvent: string } };
}

export type ScannerDB = IDBPDatabase<ScannerDb>;
const DB_NAME = 'nuits-scanner';
const QUEUE_RETENTION_MS = 24 * 3_600_000;
let dbPromise: Promise<ScannerDB> | null = null;

export const scannerStorageAvailable = (): boolean => typeof indexedDB !== 'undefined';

export function scannerDb(): Promise<ScannerDB> {
  if (!scannerStorageAvailable()) return Promise.reject(new Error('IndexedDB indisponible'));
  dbPromise ??= openDB<ScannerDb>(DB_NAME, 2, {
    upgrade(d, oldVersion) {
      // v1 (jamais déployée en production) : schéma recréé.
      if (oldVersion < 2) {
        for (const name of [...d.objectStoreNames]) d.deleteObjectStore(name);
      }
      d.createObjectStore('device');
      d.createObjectStore('snapshots', { keyPath: 'eventId' });
      d.createObjectStore('tickets', { keyPath: ['eventId', 'publicId'] }).createIndex('byEvent', 'eventId');
      d.createObjectStore('queue', { keyPath: 'scanId' }).createIndex('byEvent', 'eventId');
      d.createObjectStore('conflicts', { keyPath: 'scanId' }).createIndex('byEvent', 'eventId');
    },
  });
  return dbPromise;
}

// ---------------------------------------------------------------------------
// Verrous inter-onglets et génération de session
// ---------------------------------------------------------------------------
/** Sérialise les opérations (scan, mise à jour de la liste, synchro) entre onglets via Web Locks. */
export async function withLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
  // Web Locks absent (vieux navigateurs, jsdom) : exécution directe.
  const locks = (navigator as unknown as { locks?: LockManager }).locks;
  if (!locks || typeof locks.request !== 'function') return fn();
  return locks.request(name, { mode: 'exclusive' }, () => fn());
}
export const SCAN_LOCK = 'nuits-scan';

export class SessionChangedError extends Error {
  constructor() {
    super('Session terminée pendant l’opération');
  }
}

export async function currentGeneration(): Promise<number> {
  const g = await (await scannerDb()).get('device', 'gen');
  return typeof g === 'number' ? g : 0;
}

type AnyTx = { objectStore: (name: 'device') => { get: (k: string) => Promise<DeviceValue | undefined> }; abort: () => void; done: Promise<void> };

/** Annule une transaction volontairement (son `done` rejeté est attendu, pas une erreur). */
export function abortTx(tx: { abort: () => void; done: Promise<void> }): void {
  tx.done.catch(() => undefined);
  tx.abort();
}
/** À appeler DANS une transaction qui inclut « device » : interrompt si la session a changé. */
export async function assertGeneration(tx: AnyTx, expected: number): Promise<void> {
  const g = await tx.objectStore('device').get('gen');
  if ((typeof g === 'number' ? g : 0) !== expected) {
    abortTx(tx);
    throw new SessionChangedError();
  }
}

// ---------------------------------------------------------------------------
// Appareil, empreinte du compte, accès connus
// ---------------------------------------------------------------------------
/** Identifiant d'appareil : généré une seule fois, conservé. */
export async function deviceId(): Promise<string> {
  const db = await scannerDb();
  const tx = db.transaction('device', 'readwrite');
  let id = await tx.store.get('id');
  if (typeof id !== 'string') {
    id = crypto.randomUUID();
    await tx.store.put(id, 'id');
  }
  await tx.done;
  return id;
}

export async function ownerHash(userId: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`nuits-scanner:${userId}`));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Collectifs que le dernier compte validé en ligne peut contrôler (garde de route hors-ligne). */
export async function setScannerAccess(access: ScannerAccess): Promise<void> {
  await (await scannerDb()).put('device', access, 'access');
}
export async function getScannerAccess(): Promise<ScannerAccess | null> {
  const v = await (await scannerDb()).get('device', 'access');
  return typeof v === 'object' ? v : null;
}

export type DeviceKey = 'updateSeenAt' | 'clockHighWater';
export async function getDeviceValue(key: DeviceKey): Promise<string | null> {
  const v = await (await scannerDb()).get('device', key);
  return typeof v === 'string' ? v : null;
}
export async function setDeviceValue(key: DeviceKey, value: string | null): Promise<void> {
  const db = await scannerDb();
  if (value === null) await db.delete('device', key);
  else await db.put('device', value, key);
}

// ---------------------------------------------------------------------------
// Liste de l'événement
// ---------------------------------------------------------------------------
export async function getSnapshotMeta(eventId: string): Promise<SnapshotMeta | undefined> {
  return (await scannerDb()).get('snapshots', eventId);
}

export async function listSnapshots(): Promise<SnapshotMeta[]> {
  return (await scannerDb()).getAll('snapshots');
}

/**
 * Remplace la liste d'un événement en FUSIONNANT avec l'état local : un billet utilisé localement n'est
 * jamais rétrogradé « valide » (le serveur peut ne pas encore connaître un passage hors-ligne).
 */
export async function saveSnapshot(meta: SnapshotMeta, tickets: LocalTicket[], generation: number): Promise<void> {
  const db = await scannerDb();
  const tx = db.transaction(['device', 'snapshots', 'tickets'], 'readwrite');
  await assertGeneration(tx, generation);
  const store = tx.objectStore('tickets');
  const local = new Map((await store.index('byEvent').getAll(meta.eventId)).map((t) => [t.publicId, t]));
  let cursor = await store.index('byEvent').openCursor(meta.eventId);
  while (cursor) {
    await cursor.delete();
    cursor = await cursor.continue();
  }
  const fresh = new Set<string>();
  for (const t of tickets) {
    fresh.add(t.publicId);
    const mine = local.get(t.publicId);
    if (mine?.status === 'USED' && t.status === 'VALID') await store.put(mine); // jamais USED ⇒ VALID
    else await store.put({ ...t, localOnly: false });
  }
  // Billets admis hors-ligne mais absents de la nouvelle liste (vendus après) : conservés comme utilisés.
  for (const [publicId, mine] of local) if (!fresh.has(publicId) && mine.status === 'USED') await store.put(mine);
  await tx.objectStore('snapshots').put(meta);
  await tx.done;
}

export async function getLocalTicket(eventId: string, publicId: string): Promise<LocalTicket | undefined> {
  return (await scannerDb()).get('tickets', [eventId, publicId]);
}

// ---------------------------------------------------------------------------
// File de synchronisation
// ---------------------------------------------------------------------------
export async function pendingCount(eventId?: string, owner?: string): Promise<number> {
  const db = await scannerDb();
  const all = eventId ? await db.getAllFromIndex('queue', 'byEvent', eventId) : await db.getAll('queue');
  return owner ? all.filter((q) => q.ownerHash === owner).length : all.length;
}

export async function listQueue(eventId?: string): Promise<QueuedScan[]> {
  const db = await scannerDb();
  const all = eventId ? await db.getAllFromIndex('queue', 'byEvent', eventId) : await db.getAll('queue');
  return all.sort((a, b) => a.scannedAt.localeCompare(b.scannedAt));
}

/** Purge automatique : file d'un événement terminé depuis plus de 24 h (le serveur la refuserait). */
export async function purgeExpiredQueue(now: number = Date.now()): Promise<number> {
  const db = await scannerDb();
  const tx = db.transaction('queue', 'readwrite');
  let removed = 0;
  let c = await tx.store.openCursor();
  while (c) {
    if (Date.parse(c.value.eventEndsAt) + QUEUE_RETENTION_MS < now) {
      await c.delete();
      removed++;
    }
    c = await c.continue();
  }
  await tx.done;
  return removed;
}

// ---------------------------------------------------------------------------
// Conflits
// ---------------------------------------------------------------------------
export async function listConflicts(eventId: string): Promise<SyncConflict[]> {
  const all = await (await scannerDb()).getAllFromIndex('conflicts', 'byEvent', eventId);
  return all.sort((a, b) => b.scannedAt.localeCompare(a.scannedAt));
}

export async function unseenConflictCount(eventId: string): Promise<number> {
  return (await listConflicts(eventId)).filter((c) => !c.seen).length;
}

export async function markConflictsSeen(eventId: string): Promise<void> {
  const db = await scannerDb();
  const tx = db.transaction('conflicts', 'readwrite');
  for (const c of await tx.store.index('byEvent').getAll(eventId)) await tx.store.put({ ...c, seen: true });
  await tx.done;
}

// ---------------------------------------------------------------------------
// Purges (données personnelles uniquement : la file est conservée)
// ---------------------------------------------------------------------------
/** Données personnelles d'UN événement (liste, conflits). La file n'est pas touchée. */
export async function purgeEvent(eventId: string): Promise<void> {
  const db = await scannerDb();
  const tx = db.transaction(['snapshots', 'tickets', 'conflicts'], 'readwrite');
  await tx.objectStore('snapshots').delete(eventId);
  for (const store of ['tickets', 'conflicts'] as const) {
    let c = await tx.objectStore(store).index('byEvent').openCursor(eventId);
    while (c) {
      await c.delete();
      c = await c.continue();
    }
  }
  await tx.done;
}

/** Fin de session : listes, conflits et accès effacés, génération incrémentée. La FILE est conservée. */
export async function purgePersonal(): Promise<void> {
  const db = await scannerDb();
  const tx = db.transaction(['device', 'snapshots', 'tickets', 'conflicts'], 'readwrite');
  const g = await tx.objectStore('device').get('gen');
  await tx.objectStore('device').put((typeof g === 'number' ? g : 0) + 1, 'gen');
  await tx.objectStore('device').delete('access');
  await Promise.all([tx.objectStore('snapshots').clear(), tx.objectStore('tickets').clear(), tx.objectStore('conflicts').clear()]);
  await tx.done;
}

/** Réservé aux tests : vide aussi la file et l'identifiant d'appareil. */
export async function __wipeScannerForTests(): Promise<void> {
  const db = await scannerDb();
  const tx = db.transaction(['device', 'snapshots', 'tickets', 'conflicts', 'queue'], 'readwrite');
  await Promise.all([tx.objectStore('device').clear(), tx.objectStore('snapshots').clear(), tx.objectStore('tickets').clear(), tx.objectStore('conflicts').clear(), tx.objectStore('queue').clear()]);
  await tx.done;
}
