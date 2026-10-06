/**
 * Dernière liste de billets de l'acheteur, gardée pour l'affichage HORS-LIGNE à l'entrée.
 * ⚠ `qrPayload` est un justificatif PORTEUR (quiconque le présente entre) : ces données sont
 * traitées comme sensibles. Pas de jeton d'authentification ni d'email ici.
 *
 * Garanties :
 * - liées au compte (empreinte SHA-256 de l'id, jamais l'id en clair) : un autre compte ne les voit pas ;
 * - purgées à la déconnexion / session refusée / changement de compte, avec un marqueur
 *   « purge en attente » posé AVANT l'effacement : une purge interrompue est reprise au prochain accès ;
 * - au démarrage hors-ligne (compte inconnu), affichage seulement si l'appareil n'a connu qu'UN
 *   compte depuis la dernière purge.
 */
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { Ticket } from '../api/types';
import { registerSessionCleanup } from '../auth/sessionCleanup';

const DB_NAME = 'nuits-buyer';
type Saved = { ownerHash: string; savedAt: string; tickets: Ticket[] };
type Meta = { purgePending: boolean; owners: string[] };
interface BuyerDb extends DBSchema {
  tickets: { key: 'last'; value: Saved };
  meta: { key: 'state'; value: Meta };
}

let dbPromise: Promise<IDBPDatabase<BuyerDb>> | null = null;
function db(): Promise<IDBPDatabase<BuyerDb>> | null {
  if (typeof indexedDB === 'undefined') return null;
  dbPromise ??= openDB<BuyerDb>(DB_NAME, 2, {
    upgrade(d) {
      if (!d.objectStoreNames.contains('tickets')) d.createObjectStore('tickets');
      if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta');
    },
  });
  return dbPromise;
}

export async function ownerHash(userId: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`nuits-buyer:${userId}`));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function meta(d: IDBPDatabase<BuyerDb>): Promise<Meta> {
  return (await d.get('meta', 'state')) ?? { purgePending: false, owners: [] };
}

export async function clearTickets(): Promise<void> {
  const p = db();
  if (!p) return;
  const d = await p;
  await d.put('meta', { purgePending: true, owners: (await meta(d)).owners }, 'state');
  await d.clear('tickets');
  await d.put('meta', { purgePending: false, owners: [] }, 'state');
}

export async function saveTickets(userId: string, tickets: Ticket[]): Promise<void> {
  const p = db();
  if (!p) return;
  const d = await p;
  const m = await meta(d);
  if (m.purgePending) await clearTickets();
  const h = await ownerHash(userId);
  const owners = (await meta(d)).owners;
  await d.put('meta', { purgePending: false, owners: owners.includes(h) ? owners : [...owners, h] }, 'state');
  await d.put('tickets', { ownerHash: h, savedAt: new Date().toISOString(), tickets }, 'last');
}

/**
 * `userId` connu : ne rend que les billets de CE compte (sinon purge).
 * Inconnu (démarrage hors-ligne) : la dernière liste seulement si un seul compte a utilisé l'appareil.
 */
export async function loadTickets(userId: string | null): Promise<{ savedAt: string; tickets: Ticket[] } | null> {
  const p = db();
  if (!p) return null;
  const d = await p;
  const m = await meta(d);
  if (m.purgePending) {
    await clearTickets();
    return null;
  }
  const saved = await d.get('tickets', 'last');
  if (!saved) return null;
  if (userId) {
    if (saved.ownerHash !== (await ownerHash(userId))) {
      await clearTickets();
      return null;
    }
  } else if (m.owners.length !== 1 || m.owners[0] !== saved.ownerHash) {
    return null;
  }
  return { savedAt: saved.savedAt, tickets: saved.tickets };
}

/** Réservé aux tests : simule une purge interrompue. */
export async function __markPurgePendingForTests(): Promise<void> {
  const p = db();
  if (!p) return;
  const d = await p;
  await d.put('meta', { ...(await meta(d)), purgePending: true }, 'state');
}

registerSessionCleanup(clearTickets);
