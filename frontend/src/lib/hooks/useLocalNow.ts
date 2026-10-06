import { useEffect, useState } from 'react';

/**
 * Horloge LOCALE (durées mesurées localement, ex. fraîcheur d'un cache), mise à jour toutes les
 * `intervalMs` et suspendue quand l'onglet est masqué (économie de batterie).
 */
export function useLocalNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const tick = () => {
      if (document.visibilityState !== 'hidden') setNow(Date.now());
    };
    const id = setInterval(tick, intervalMs);
    document.addEventListener('visibilitychange', tick);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [intervalMs]);
  return now;
}
