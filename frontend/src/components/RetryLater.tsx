import { useEffect, useState, type ReactNode } from 'react';
import { Icon } from './Icon';

/**
 * Service momentanément indisponible (503) : message rassurant + « Réessayer », actif seulement une fois
 * le délai `Retry-After` écoulé (compte à rebours affiché). `retryAt` : instant LOCAL calculé à la réception.
 */
export function RetryLater({ retryAt, onRetry, busy, children }: { retryAt: number; onRetry: () => void; busy?: boolean; children: ReactNode }) {
  const [now, setNow] = useState(() => Date.now());
  const wait = Math.max(0, Math.ceil((retryAt - now) / 1000));
  useEffect(() => {
    if (wait === 0) return;
    const id = setInterval(() => {
      setNow(Date.now());
    }, 500);
    return () => {
      clearInterval(id);
    };
  }, [wait]);
  return (
    <div className="alert alert--warning" role="alert">
      <Icon name="clock" />
      <div className="stack stack--sm">
        <p>{children}</p>
        <p>
          <button type="button" className="btn btn--secondary btn--small" disabled={wait > 0 || busy} onClick={onRetry}>
            <Icon name="retry" size="sm" /> {wait > 0 ? `Réessayer (dans ${String(wait)} s)` : 'Réessayer'}
          </button>
        </p>
      </div>
    </div>
  );
}
