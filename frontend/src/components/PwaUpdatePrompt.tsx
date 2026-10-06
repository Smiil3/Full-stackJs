import { useRegisterSW } from 'virtual:pwa-register/react';

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
    onRegisterError(error: unknown) {
      console.warn('Service worker non enregistré', error);
    },
  });

  if (needRefresh) {
    return (
      <div className="alert alert--info row" role="status">
        <span>Une nouvelle version de l’application est disponible.</span>
        <button type="button" className="btn btn--small" onClick={() => void updateServiceWorker(true)}>
          Mettre à jour
        </button>
        <button type="button" className="btn btn--secondary btn--small" onClick={() => setNeedRefresh(false)}>
          Plus tard
        </button>
      </div>
    );
  }
  if (offlineReady) {
    return (
      <div className="alert alert--success row" role="status">
        <span>L’application est prête à fonctionner hors-ligne.</span>
        <button type="button" className="btn btn--secondary btn--small" onClick={() => setOfflineReady(false)}>
          OK
        </button>
      </div>
    );
  }
  return null;
}
