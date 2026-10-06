import { useEffect, useRef } from 'react';
import { useNow } from '../lib/hooks/useNow';
import { formatDuration } from '../lib/time';

/**
 * Compte à rebours accessible : affichage visuel chaque seconde, annonce aux lecteurs d'écran
 * seulement par paliers (pas une annonce par seconde).
 */
export function Countdown({ until, onExpire, label }: { until: string; onExpire?: () => void; label: string }) {
  const now = useNow(1000);
  const remaining = Date.parse(until) - now;
  const expired = remaining <= 0;
  const fired = useRef(false);
  useEffect(() => {
    if (expired && !fired.current) {
      fired.current = true;
      onExpire?.();
    }
  }, [expired, onExpire]);
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
