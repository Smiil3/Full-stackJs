/**
 * Nettoyages à exécuter quand la session se termine (logout, refresh refusé) ou change d'utilisateur :
 * données hors-ligne du scanner, billets mis en cache, etc. Chaque module enregistre le sien.
 */
type Cleanup = () => void | Promise<void>;
const cleanups = new Set<Cleanup>();

export function registerSessionCleanup(fn: Cleanup): () => void {
  cleanups.add(fn);
  return () => cleanups.delete(fn);
}

export async function runSessionCleanups(): Promise<void> {
  await Promise.allSettled([...cleanups].map(async (fn) => fn()));
}
