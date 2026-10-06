import type { OrderStatus } from '../api/types';
import { ORDER_STATUS_LABELS } from '../lib/labels';

const TONE: Record<OrderStatus, string> = {
  PENDING_PAYMENT: 'low',
  AWAITING_TRANSFER: 'low',
  PAID: 'available',
  EXPIRED: 'sold_out',
  CANCELLED: 'sold_out',
  REFUNDED: 'sold_out',
};

export function OrderStatusBadge({ status }: { status: OrderStatus }) {
  return <span className={`badge badge--${TONE[status]}`}>{ORDER_STATUS_LABELS[status]}</span>;
}
