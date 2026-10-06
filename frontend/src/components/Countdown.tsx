import { useEffect, useRef } from 'react';
import { useNow } from '../lib/hooks/useNow';
import { formatDuration } from '../lib/time';

/** Intervalle des relances `onExpire` tant que l'échéance est passée (le serveur n'a pas encore tranché). */
export const EXPIRED_RETRY_MS = 10_000;

/**
 * Compte à rebours accessible (horloge du serveur) : affichage chaque seconde, annonce aux lecteurs
 * d'écran par paliers. À l'échéance, `onExpire` est appelé puis relancé périodiquement jusqu'à ce que
 * l'échéance change ou que le composant disparaisse (ex. statut mis à jour par le serveur).
 */
export function Countdown({ until, onExpire, label }: { until: string; onExpire?: () => void; label: string }) {
  const now = useNow(1000);
  const remaining = Date.parse(until) - now;
  const expired = remaining <= 0;
  const onExpireRef = useRef(onExpire);
  useEffect(() => {
    onExpireRef.current = onExpire;
  });
  useEffect(() => {
    if (!expired) return;
    onExpireRef.current?.();
    const id = setInterval(() => onExpireRef.current?.(), EXPIRED_RETRY_MS);
    return () => {
      clearInterval(id);
    };
  }, [expired, until]);
  const minutes = Math.ceil(remaining / 60_000);
  const announce = expired ? 'Délai écoulé.' : minutes <= 5 || minutes % 5 === 0 ? `${label} : ${minutes} minute${minutes > 1 ? 's' : ''} restante${minutes > 1 ? 's' : ''}.` : '';
  return (
    <p className={`countdown${remaining < 120_000 ? ' countdown--urgent' : ''}`}>
      <span>{label} : </span>
      <strong>{expired ? 'délai écoulé' : formatDuration(remaining)}</strong>
      <span className="visually-hidden" aria-live="polite">
        {announce}
      </span>
    </p>
  );
}
