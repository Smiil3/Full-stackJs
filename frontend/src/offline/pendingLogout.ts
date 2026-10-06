/**
 * « Déconnexion en attente » : la déconnexion locale a eu lieu mais le serveur n'a pas pu révoquer le
 * cookie de session (pas de réseau). Tant que ce drapeau existe, la session n'est JAMAIS restaurée :
 * au prochain démarrage en ligne, POST /auth/logout est envoyé AVANT tout refresh.
 * Aucun secret : un simple horodatage.
 */
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';

interface SessionDb extends DBSchema {
  flags: { key: 'logoutPendingSince'; value: string };
}
let dbPromise: Promise<IDBPDatabase<SessionDb>> | null = null;
function db(): Promise<IDBPDatabase<SessionDb>> | null {
  if (typeof indexedDB === 'undefined') return null;
  dbPromise ??= openDB<SessionDb>('nuits-session', 1, {
    upgrade(d) {
      d.createObjectStore('flags');
    },
  });
  return dbPromise;
}

export async function setLogoutPending(): Promise<void> {
  const p = db();
  if (p) await (await p).put('flags', new Date().toISOString(), 'logoutPendingSince');
}

export async function isLogoutPending(): Promise<boolean> {
  const p = db();
  if (!p) return false;
  return (await (await p).get('flags', 'logoutPendingSince')) !== undefined;
}

export async function clearLogoutPending(): Promise<void> {
  const p = db();
  if (p) await (await p).delete('flags', 'logoutPendingSince');
}
