import type { OrderStatus } from '../api/types';
import { ORDER_STATUS_LABELS } from '../lib/labels';
import { lookup } from '../lib/lookup';
import { Icon } from './Icon';

/** Statut de commande : jamais de vert ni de rouge (réservés au scanner) ; « en attente » = contour or + horloge. */
const TONE: Record<OrderStatus, string> = {
  PENDING_PAYMENT: 'pending',
  AWAITING_TRANSFER: 'pending',
  PAID: 'available',
  EXPIRED: 'sold_out',
  CANCELLED: 'sold_out',
  REFUNDED: 'sold_out',
};

export function OrderStatusBadge({ status }: { status: OrderStatus }) {
  const tone = lookup(TONE, status) ?? 'pending';
  return (
    <span className={`badge badge--${tone}`}>
      {tone === 'pending' ? <Icon name="clock" size="sm" /> : null}
      {lookup(ORDER_STATUS_LABELS, status) ?? 'Statut inconnu'}
    </span>
  );
}
