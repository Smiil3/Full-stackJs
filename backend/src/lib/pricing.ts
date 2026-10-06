import type { TicketType } from '../generated/prisma/client.js';

export interface PriceAt {
  unitPriceCents: number;
  isEarly: boolean;
}

/**
 * Prix applicable à l'instant `now` (calcul serveur uniquement) : le tarif early s'applique
 * strictement AVANT `earlyUntil` (à l'instant exact de fin, c'est déjà le prix normal).
 */
export function priceAt(tt: Pick<TicketType, 'priceCents' | 'earlyPriceCents' | 'earlyUntil'>, now: Date): PriceAt {
  if (tt.earlyPriceCents !== null && tt.earlyUntil !== null && now.getTime() < tt.earlyUntil.getTime()) {
    return { unitPriceCents: tt.earlyPriceCents, isEarly: true };
  }
  return { unitPriceCents: tt.priceCents, isEarly: false };
}

export type Availability = 'AVAILABLE' | 'LOW' | 'SOLD_OUT';

/**
 * Disponibilité publique, sans chiffre exact. Un type avec des personnes en liste d'attente est
 * « complet » pour le public : les places libérées leur reviennent d'abord.
 */
export function availabilityOf(tt: Pick<TicketType, 'capacity' | 'sold' | 'held'>, waiting: number): Availability {
  const remaining = tt.capacity - tt.sold - tt.held;
  if (remaining <= 0 || waiting > 0) return 'SOLD_OUT';
  return remaining * 10 <= tt.capacity ? 'LOW' : 'AVAILABLE';
}

export function bestAvailability(list: Availability[]): Availability {
  if (list.includes('AVAILABLE')) return 'AVAILABLE';
  if (list.includes('LOW')) return 'LOW';
  return 'SOLD_OUT';
}
