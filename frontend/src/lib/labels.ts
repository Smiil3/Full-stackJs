import type { EventStatus, OrderStatus, RefundReason, RefundStatus } from '../api/types';

export const ORDER_STATUS_LABELS: Record<OrderStatus, string> = {
  PENDING_PAYMENT: 'En attente de paiement',
  AWAITING_TRANSFER: 'En attente du virement',
  PAID: 'Payée',
  EXPIRED: 'Expirée',
  CANCELLED: 'Annulée',
  REFUNDED: 'Remboursée',
};

export const EVENT_STATUS_LABELS: Record<EventStatus, string> = { DRAFT: 'Brouillon', PUBLISHED: 'Publié', CANCELLED: 'Annulé' };

export const REFUND_STATUS_LABELS: Record<RefundStatus, string> = {
  PENDING: 'En cours',
  SUCCEEDED: 'Effectué',
  MANUAL_REQUIRED: 'À effectuer manuellement',
  FAILED: 'Échec — à effectuer manuellement',
};

export const REFUND_REASON_LABELS: Record<RefundReason, string> = {
  SELF_CANCELLATION: 'Annulation par l’acheteur',
  EVENT_CANCELLED: 'Événement annulé',
  LATE_PAYMENT: 'Paiement reçu après expiration',
  DUPLICATE_PAYMENT: 'Paiement en double',
  UNEXPECTED_PAYMENT: 'Paiement inattendu',
};
