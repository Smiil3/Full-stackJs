import type { Order } from '../../api/types';
import { formatCents } from '../../lib/money';

/** Montants tels que renvoyés par l'API (jamais recalculés côté client). */
export function OrderSummary({ order }: { order: Order }) {
  return (
    <dl className="kv card">
      {order.items.map((i) => (
        <div key={i.ticketTypeId} className="kv__row">
          <dt>
            {i.quantity} × {i.name}
          </dt>
          <dd>{formatCents(i.unitPriceCents * i.quantity)}</dd>
        </div>
      ))}
      <dt>Frais de service</dt>
      <dd>{formatCents(order.serviceFeeCents)}</dd>
      <dt>Total</dt>
      <dd>
        <strong>{formatCents(order.totalCents)}</strong>
      </dd>
      {order.refundAmountCents !== null ? (
        <>
          <dt>Remboursé</dt>
          <dd>{formatCents(order.refundAmountCents)}</dd>
        </>
      ) : null}
    </dl>
  );
}
