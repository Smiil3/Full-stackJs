import { useState } from 'react';
import { Link } from 'react-router';
import { apiPath } from '../../api/client';
import { useOrders } from '../../api/hooks/orders';
import { ErrorAlert } from '../../components/ErrorAlert';
import { OrderStatusBadge } from '../../components/OrderStatusBadge';
import { PageLoader } from '../../components/PageLoader';
import { formatCents } from '../../lib/money';
import { formatDateTime } from '../../lib/time';

export function OrdersPage() {
  const [page, setPage] = useState(1);
  const { data, error, isPending } = useOrders(page);
  return (
    <section className="page">
      <h1>Mes commandes</h1>
      {isPending ? <PageLoader /> : null}
      <ErrorAlert error={error} />
      {data?.items.length === 0 ? (
        <p>
          Aucune commande pour le moment. <Link to="/">Voir les événements</Link>
        </p>
      ) : null}
      <ul className="list-reset stack">
        {data?.items.map((o) => (
          <li key={o.id} className="card stack">
            <h2 className="card__title">
              <Link to={apiPath`/orders/${o.id}`}>{o.eventTitle}</Link>
            </h2>
            <p className="muted">{formatDateTime(o.eventStartsAt, o.eventTimezone)}</p>
            <p className="row">
              <OrderStatusBadge status={o.status} />
              <span>{formatCents(o.totalCents)}</span>
            </p>
          </li>
        ))}
      </ul>
      {data && data.total > data.pageSize ? (
        <nav className="row" aria-label="Pagination">
          <button type="button" className="btn btn--secondary" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            Précédent
          </button>
          <button type="button" className="btn btn--secondary" disabled={page * data.pageSize >= data.total} onClick={() => setPage((p) => p + 1)}>
            Suivant
          </button>
        </nav>
      ) : null}
    </section>
  );
}
