import { lookup } from '../lib/lookup';
import type { Availability } from '../api/types';

const TONES: Record<Availability, string> = { AVAILABLE: 'available', LOW: 'low', SOLD_OUT: 'sold_out' };
const LABELS: Record<Availability, string> = { AVAILABLE: 'Disponible', LOW: 'Dernières places', SOLD_OUT: 'Complet' };

/** Disponibilité : texte + forme (pastille, fond or, fond neutre), jamais la couleur seule. */
export function AvailabilityBadge({ value, waitlist = false }: { value: Availability; waitlist?: boolean }) {
  // Valeur venant du serveur : classe et libellé tirés d'une table, jamais de la chaîne brute.
  const tone = lookup(TONES, value) ?? 'low';
  const label = lookup(LABELS, value) ?? 'Disponibilité inconnue';
  return <span className={`badge badge--${tone}`}>{value === 'SOLD_OUT' && waitlist ? `${label} · liste d’attente` : label}</span>;
}
