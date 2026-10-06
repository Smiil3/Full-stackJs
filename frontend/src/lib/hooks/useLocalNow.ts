import { useEffect, useState } from 'react';

/** Horloge LOCALE (pour des durées mesurées localement, ex. fraîcheur d'un cache). */
export function useLocalNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => {
      setNow(Date.now());
    }, intervalMs);
    return () => {
      clearInterval(id);
    };
  }, [intervalMs]);
  return now;
}
