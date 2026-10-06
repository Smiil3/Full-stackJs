import { useEffect, useState } from 'react';
import { useRegisterSW } from 'virtual:pwa-register/react';
import { getDeviceValue, scannerStorageAvailable, setDeviceValue } from '../scanner/db';
import { startPeriodicUpdate } from '../lib/pwaUpdate';

/** Mise à jour en attente depuis plus longtemps ⇒ bandeau insistant (version à jour avant l'événement). */
export const UPDATE_INSIST_MS = 24 * 3_600_000;

let stopPeriodicUpdate: (() => void) | null = null;

/**
 * Enregistre le service worker (coquille hors-ligne, indispensable au scanner) et propose la mise à
 * jour quand une nouvelle version est disponible — jamais de rechargement forcé en plein scan.
 */
export function PwaUpdatePrompt() {
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    offlineReady: [offlineReady, setOfflineReady],
    updateServiceWorker,
  } = useRegisterSW({
    immediate: true,
    onRegisteredSW(_url: string, registration: ServiceWorkerRegistration | undefined) {
      if (!registration) return;
      stopPeriodicUpdate?.();
      stopPeriodicUpdate = startPeriodicUpdate(registration);
    },
    onRegisterError(error: unknown) {
      console.warn('Service worker non enregistré', error);
    },
  });

  const [insist, setInsist] = useState(false);
  useEffect(() => {
    if (!needRefresh || !scannerStorageAvailable()) return;
    void (async () => {
      let seen = await getDeviceValue('updateSeenAt');
      if (!seen) {
        seen = new Date().toISOString();
        await setDeviceValue('updateSeenAt', seen);
      }
      setInsist(Date.now() - Date.parse(seen) > UPDATE_INSIST_MS);
    })().catch(() => undefined);
  }, [needRefresh]);

  if (needRefresh) {
    return (
      <div className="pwa-update" role={insist ? 'alert' : 'status'}>
        <p>
          {insist ? <strong>Mise à jour en attente depuis plus de 24 h : installez-la avant le prochain contrôle d’accès. </strong> : null}
          Une nouvelle version est prête.
        </p>
        <button
          type="button"
          className="btn btn--small"
          onClick={() => {
            void setDeviceValue('updateSeenAt', null).catch(() => undefined);
            void updateServiceWorker(true);
          }}
        >
          Mettre à jour
        </button>
        <button
          type="button"
          className="btn btn--ghost btn--small"
          onClick={() => {
            setNeedRefresh(false);
          }}
        >
          Plus tard
        </button>
      </div>
    );
  }
  if (offlineReady) {
    return (
      <div className="pwa-update" role="status">
        <p>L’application est prête à fonctionner hors-ligne.</p>
        <button
          type="button"
          className="btn btn--secondary btn--small"
          onClick={() => {
            setOfflineReady(false);
          }}
        >
          OK
        </button>
      </div>
    );
  }
  return null;
}
