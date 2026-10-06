import type { EventAdmin, TicketTypeBody } from '../../api/types';
import { eurosToCents } from '../../lib/money';
import { zonedInputToUtc } from '../../lib/time';

export type Draft = { name: string; description: string; capacity: string; price: string; early: boolean; earlyPrice: string; earlyUntil: string };

/** Saisie en euros convertie en centimes SANS flottant (eurosToCents) ; validations UX, le serveur fait foi. */
export function draftToBody(d: Draft, event: Pick<EventAdmin, 'timezone' | 'salesEndAt'>): { body: TicketTypeBody | null; errors: Partial<Record<keyof Draft, string>> } {
  const errors: Partial<Record<keyof Draft, string>> = {};
  const name = d.name.trim();
  if (name.length < 1 || name.length > 80) errors.name = 'Nom requis (80 caractères max).';
  const capacity = /^\d{1,6}$/.test(d.capacity.trim()) ? Number(d.capacity.trim()) : NaN;
  if (!(capacity >= 1 && capacity <= 100_000)) errors.capacity = 'Nombre entier entre 1 et 100 000.';
  const price = eurosToCents(d.price);
  if (!price.ok) errors.price = 'Montant invalide (ex. 25 ou 19,99 ; 10 000 € max).';
  let earlyPriceCents: number | null = null;
  let earlyUntil: string | null = null;
  if (d.early) {
    const ep = eurosToCents(d.earlyPrice);
    if (!ep.ok) errors.earlyPrice = 'Montant invalide.';
    else if (price.ok && ep.value >= price.value) errors.earlyPrice = 'Le tarif early doit être inférieur au prix normal.';
    else earlyPriceCents = ep.value;
    const until = zonedInputToUtc(d.earlyUntil, event.timezone);
    if (!until.ok) errors.earlyUntil = 'Date de fin du tarif early requise.';
    else if (until.iso > event.salesEndAt) errors.earlyUntil = 'Doit précéder la fin des ventes.';
    else earlyUntil = until.iso;
  }
  if (Object.keys(errors).length || !price.ok) return { body: null, errors };
  return {
    body: { name, description: d.description.trim() || null, capacity, priceCents: price.value, earlyPriceCents, earlyUntil },
    errors,
  };
}

