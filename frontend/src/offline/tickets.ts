/**
 * Dernière liste de billets de l'acheteur, gardée pour l'affichage HORS-LIGNE à l'entrée.
 * Contient uniquement ce que GET /me/tickets renvoie (pas de token, pas d'email).
 * Purgée au logout / session refusée / changement de compte (registerSessionCleanup).
 */
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { Ticket } from '../api/types';
import { registerSessionCleanup } from '../auth/sessionCleanup';

const DB_NAME = 'nuits-buyer';
type Saved = { userId: string; savedAt: string; tickets: Ticket[] };
interface BuyerDb extends DBSchema {
  tickets: { key: 'last'; value: Saved };
}

let dbPromise: Promise<IDBPDatabase<BuyerDb>> | null = null;
function db(): Promise<IDBPDatabase<BuyerDb>> | null {
  if (typeof indexedDB === 'undefined') return null;
  dbPromise ??= openDB<BuyerDb>(DB_NAME, 1, {
    upgrade(d) {
      d.createObjectStore('tickets');
    },
  });
  return dbPromise;
}

export async function saveTickets(userId: string, tickets: Ticket[]): Promise<void> {
  const d = db();
  if (!d) return;
  await (await d).put('tickets', { userId, savedAt: new Date().toISOString(), tickets }, 'last');
}

/** `userId` connu : ne rend que les billets de CE compte. Inconnu (démarrage hors-ligne) : la dernière liste. */
export async function loadTickets(userId: string | null): Promise<Saved | null> {
  const d = db();
  if (!d) return null;
  const saved = await (await d).get('tickets', 'last');
  if (!saved) return null;
  if (userId && saved.userId !== userId) {
    await clearTickets();
    return null;
  }
  return saved;
}

export async function clearTickets(): Promise<void> {
  const d = db();
  if (!d) return;
  await (await d).clear('tickets');
}

registerSessionCleanup(clearTickets);
