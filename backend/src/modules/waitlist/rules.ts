import { minutes } from '../../config/units.js';
import { WAITLIST_MIN_OFFER_MINUTES } from '../../config/waitlist.js';

/** Ventes ouvertes au sens de la liste d'attente (contrat 1.14) : salesStartAt ≤ now < min(salesEndAt, startsAt). */
export function salesOpen(event: { status: string; salesStartAt: Date; salesEndAt: Date; startsAt: Date }, now: Date): boolean {
  return event.status === 'PUBLISHED' && now >= event.salesStartAt && now < event.salesEndAt && now < event.startsAt;
}

/**
 * Instant à partir duquel plus aucune offre n'est émise (contrat 1.18 §6, audit B'5) : il resterait moins de
 * WAITLIST_MIN_OFFER_MINUTES avant la fin des ventes, l'offre serait intenable. Les places vont alors au public :
 * la liste d'attente ne bloque plus la réservation ni l'affichage.
 */
export function offersCutoff(now: Date): Date {
  return new Date(now.getTime() + minutes(WAITLIST_MIN_OFFER_MINUTES));
}

/** Offres encore possibles : ventes ouvertes ET au moins WAITLIST_MIN_OFFER_MINUTES avant leur fin. */
export function offersOpen(event: { status: string; salesStartAt: Date; salesEndAt: Date; startsAt: Date }, now: Date): boolean {
  const cutoff = offersCutoff(now).getTime();
  return salesOpen(event, now) && cutoff <= event.salesEndAt.getTime() && cutoff <= event.startsAt.getTime();
}
