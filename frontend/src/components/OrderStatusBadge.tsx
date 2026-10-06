import type { OrderStatus } from '../api/types';
import { ORDER_STATUS_LABELS } from '../lib/labels';
import { lookup } from '../lib/lookup';

const TONE: Record<OrderStatus, string> = {
  PENDING_PAYMENT: 'low',
  AWAITING_TRANSFER: 'low',
  PAID: 'available',
  EXPIRED: 'sold_out',
  CANCELLED: 'sold_out',
  REFUNDED: 'sold_out',
};

export function OrderStatusBadge({ status }: { status: OrderStatus }) {
  return <span className={`badge badge--${lookup(TONE, status) ?? 'low'}`}>{lookup(ORDER_STATUS_LABELS, status) ?? 'Statut inconnu'}</span>;
}
