import type { OrderStatus } from '../api/types';

export const ORDER_STATUS_LABELS: Record<OrderStatus, string> = {
  PENDING_PAYMENT: 'En attente de paiement',
  AWAITING_TRANSFER: 'En attente du virement',
  PAID: 'Payée',
  EXPIRED: 'Expirée',
  CANCELLED: 'Annulée',
  REFUNDED: 'Remboursée',
};
