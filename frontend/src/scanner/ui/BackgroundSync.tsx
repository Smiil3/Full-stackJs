import { useEffect } from 'react';
import { useAuth } from '../../auth/AuthContext';
import { useOnline } from '../../lib/hooks/useOnline';
import { listQueue, ownerHash, purgeExpiredQueue, scannerStorageAvailable } from '../db';
import { syncEvent } from '../sync';

const INTERVAL_MS = 30_000;

/**
 * Transmet en arrière-plan les passages hors-ligne en attente du compte connecté (y compris ceux d'une
 * session précédente du MÊME compte), quel que soit l'écran affiché ; purge les files expirées.
 */
export function ScannerBackgroundSync() {
  const { status, user } = useAuth();
  const online = useOnline();
  useEffect(() => {
    if (status !== 'authenticated' || !user || !online || !scannerStorageAvailable()) return;
    let stopped = false;
    const run = async () => {
      await purgeExpiredQueue().catch(() => 0);
      const owner = await ownerHash(user.id);
      const groups = new Map<string, { orgId: string; eventId: string }>();
      for (const q of await listQueue().catch(() => [])) if (q.ownerHash === owner) groups.set(`${q.orgId}:${q.eventId}`, { orgId: q.orgId, eventId: q.eventId });
      for (const g of groups.values()) {
        if (stopped) return;
        await syncEvent(g.orgId, g.eventId, owner).catch(() => undefined);
      }
    };
    const first = setTimeout(() => void run(), 0);
    const id = setInterval(() => void run(), INTERVAL_MS);
    return () => {
      stopped = true;
      clearTimeout(first);
      clearInterval(id);
    };
  }, [status, user, online]);
  return null;
}
