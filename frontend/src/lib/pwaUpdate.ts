/** Recherche d'une nouvelle version : toutes les 30 min, seulement quand l'application est visible. */
export const UPDATE_CHECK_MS = 30 * 60_000;

/**
 * Vérifie périodiquement la présence d'une nouvelle version (un scanner peut rester ouvert des jours :
 * sans cela, la mise à jour n'est cherchée qu'au chargement). Rattrapage au retour au premier plan.
 */
export function startPeriodicUpdate(registration: { update: () => Promise<unknown> }, everyMs = UPDATE_CHECK_MS): () => void {
  let last = Date.now();
  const check = () => {
    if (document.visibilityState !== 'visible' || !navigator.onLine) return;
    if (Date.now() - last < everyMs) return;
    last = Date.now();
    registration.update().catch(() => undefined);
  };
  const timer = setInterval(check, everyMs);
  document.addEventListener('visibilitychange', check);
  return () => {
    clearInterval(timer);
    document.removeEventListener('visibilitychange', check);
  };
}
