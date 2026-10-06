import type { Order } from '../../api/types';

/**
 * Annulation proposée si le serveur l'annonce possible (`refundPreviewCents` non nul, contrat v1.6) ;
 * pour une commande payée, on masque aussi le bouton dès que l'échéance est passée (page restée ouverte).
 */
export function canCancel(order: Order, now: number): boolean {
  if (order.refundPreviewCents === null) return false;
  if (order.status === 'PAID') return order.cancellableUntil !== null && now < Date.parse(order.cancellableUntil);
  return order.status === 'PENDING_PAYMENT' || order.status === 'AWAITING_TRANSFER';
}
