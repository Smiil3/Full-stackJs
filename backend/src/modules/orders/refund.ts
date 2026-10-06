import { floorPercentOf } from '../../lib/money.js';

/** Champs figés sur la commande nécessaires au calcul du remboursement. */
export interface RefundBasis {
  subtotalCents: number;
  serviceFeeCents: number;
  totalCents: number;
  refundPercent: number;
  serviceFeeRefundable: boolean;
}

/**
 * Remboursement d'une annulation self-service (contrat §4) — fonction UNIQUE, utilisée à la fois pour
 * l'aperçu `refundPreviewCents` et pour le remboursement réel :
 * floor(subtotal × refundPercent / 100) + frais de service s'ils sont remboursables (figé sur la commande).
 */
export function selfCancellationRefund(order: RefundBasis): number {
  return floorPercentOf(order.subtotalCents, order.refundPercent) + (order.serviceFeeRefundable ? order.serviceFeeCents : 0);
}

/** Annulation de l'événement par l'organisateur : remboursement intégral, frais compris. */
export function eventCancellationRefund(order: RefundBasis): number {
  return order.totalCents;
}

export interface CancellationState {
  status: string;
  cancellableUntil: Date | null;
  eventStartsAt: Date;
  scannedTickets: number;
}

/** L'acheteur peut-il annuler SA commande payée maintenant ? (statut, billet non scanné, délai, activation) */
export function canSelfCancelPaid(o: CancellationState, now: Date): boolean {
  return o.status === 'PAID'
    && o.scannedTickets === 0
    && o.cancellableUntil !== null
    && now.getTime() < o.cancellableUntil.getTime()
    && now.getTime() < o.eventStartsAt.getTime();
}

/** `refundPreviewCents` : montant remboursé si l'acheteur annulait maintenant ; null si impossible ; 0 si non payée. */
export function refundPreview(order: RefundBasis & CancellationState, now: Date): number | null {
  if (order.status === 'PENDING_PAYMENT' || order.status === 'AWAITING_TRANSFER') return 0;
  return canSelfCancelPaid(order, now) ? selfCancellationRefund(order) : null;
}
