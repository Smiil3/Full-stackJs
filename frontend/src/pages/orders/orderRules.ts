import type { Order } from '../../api/types';

export function canCancel(order: Order, now: number): boolean {
  if (order.status === 'PENDING_PAYMENT' || order.status === 'AWAITING_TRANSFER') return true;
  return order.status === 'PAID' && order.cancellableUntil !== null && now < Date.parse(order.cancellableUntil);
}

/** Estimation affichée AVANT confirmation ; le montant réel vient de la réponse de l'API. */
export function refundPreviewCents(order: Order): number {
  return Math.floor((order.subtotalCents * order.refundPercent) / 100);
}
