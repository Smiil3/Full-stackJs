import type { Availability } from '../api/types';

const LABELS: Record<Availability, string> = { AVAILABLE: 'Places disponibles', LOW: 'Dernières places', SOLD_OUT: 'Complet' };

export function AvailabilityBadge({ value }: { value: Availability }) {
  return <span className={`badge badge--${value.toLowerCase()}`}>{LABELS[value]}</span>;
}
