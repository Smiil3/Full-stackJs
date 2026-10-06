import { lookup } from '../lib/lookup';
import type { Availability } from '../api/types';

const TONES: Record<Availability, string> = { AVAILABLE: 'available', LOW: 'low', SOLD_OUT: 'sold_out' };
const LABELS: Record<Availability, string> = { AVAILABLE: 'Places disponibles', LOW: 'Dernières places', SOLD_OUT: 'Complet' };

export function AvailabilityBadge({ value }: { value: Availability }) {
  // Valeur venant du serveur : classe et libellé tirés d'une table, jamais de la chaîne brute.
  const tone = lookup(TONES, value) ?? 'low';
  return <span className={`badge badge--${tone}`}>{lookup(LABELS, value) ?? 'Disponibilité inconnue'}</span>;
}
