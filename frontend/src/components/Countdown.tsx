import { useEffect, useRef, useState } from 'react';
import { useNow } from '../lib/hooks/useNow';
import { formatDuration } from '../lib/time';

/** Intervalle des relances `onExpire` tant que l'échéance est passée (le serveur n'a pas encore tranché). */
export const EXPIRED_RETRY_MS = 10_000;

const RING_R = 52;
const RING_C = 2 * Math.PI * RING_R;

/**
 * Compte à rebours accessible (horloge du serveur). À l'échéance, `onExpire` est appelé puis relancé
 * périodiquement jusqu'à ce que l'échéance change ou que le composant disparaisse.
 * `ring` (offre de liste d'attente uniquement) : anneau SVG mm:ss, progression par l'ATTRIBUT
 * stroke-dashoffset (compatible CSP), `role="timer"` dont l'aria-label change chaque minute.
 */
export function Countdown({ until, onExpire, label, ring = false, totalMs }: { until: string; onExpire?: () => void; label: string; ring?: boolean; totalMs?: number }) {
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
  // Durée de référence de l'anneau : fournie, sinon le temps restant au premier affichage.
  const [firstSeen] = useState(() => Math.max(remaining, 1));
  const minutes = Math.ceil(remaining / 60_000);
  const minutesText = `${minutes} minute${minutes > 1 ? 's' : ''}`;

  if (ring) {
    const total = Math.max(totalMs ?? firstSeen, 1);
    const offset = RING_C * (1 - Math.min(1, Math.max(0, remaining) / total));
    return (
      <div className="countdown countdown--ring" role="timer" aria-label={expired ? 'Délai écoulé' : `${label} : ${minutesText}`}>
        <svg viewBox="0 0 120 120" aria-hidden="true" focusable="false">
          <circle className="countdown__track" cx="60" cy="60" r={RING_R} />
          <circle className="countdown__progress" cx="60" cy="60" r={RING_R} strokeDasharray={RING_C} strokeDashoffset={offset} />
        </svg>
        <span aria-hidden="true">
          <span className="countdown__value">{expired ? '00:00' : formatClock(remaining)}</span>
          <span className="countdown__label">{expired ? 'délai écoulé' : 'restantes'}</span>
        </span>
      </div>
    );
  }

  const announce = expired ? 'Délai écoulé.' : minutes <= 5 || minutes % 5 === 0 ? `${label} : ${minutesText} restante${minutes > 1 ? 's' : ''}.` : '';
  return (
    <p className="countdown-inline">
      <span>{label} : </span>
      <strong className="countdown">{expired ? 'délai écoulé' : formatDuration(remaining)}</strong>
      <span className="visually-hidden" aria-live="polite">
        {announce}
      </span>
    </p>
  );
}

/** mm:ss (ou h:mm:ss au-delà d'une heure). */
function formatClock(ms: number): string {
  const s = Math.ceil(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}
