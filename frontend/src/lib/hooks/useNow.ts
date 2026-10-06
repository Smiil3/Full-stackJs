import { useEffect, useState } from 'react';
import { serverNow } from '../../api/serverClock';

/**
 * Instant présent selon le SERVEUR (horloge corrigée), rafraîchi toutes les `intervalMs`.
 * À utiliser pour toute échéance métier (comptes à rebours, offres, annulation).
 */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(serverNow);
  useEffect(() => {
    const id = setInterval(() => {
      setNow(serverNow());
    }, intervalMs);
    return () => {
      clearInterval(id);
    };
  }, [intervalMs]);
  return now;
}
