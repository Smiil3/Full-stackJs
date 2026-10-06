import { useState } from 'react';
import { Link } from 'react-router';
import { useEvents } from '../../api/hooks/catalog';
import { apiPath } from '../../api/client';
import { AvailabilityBadge } from '../../components/AvailabilityBadge';
import { ErrorAlert } from '../../components/ErrorAlert';
import { EventTime } from '../../components/EventTime';
import { PageLoader } from '../../components/PageLoader';
import { formatCents } from '../../lib/money';

const PAGE_SIZE = 12;

export function EventsPage() {
  const [page, setPage] = useState(1);
  const { data, error, isPending, isPlaceholderData } = useEvents({ page, pageSize: PAGE_SIZE });

  return (
    <section className="page">
      <h1>Événements à venir</h1>
      {isPending ? <PageLoader /> : null}
      <ErrorAlert error={error} />
      {data && data.items.length === 0 ? <p>Aucun événement à venir pour le moment.</p> : null}
      {data ? (
        <ul className="list-reset grid-cards" aria-busy={isPlaceholderData}>
          {data.items.map((e) => (
            <li key={e.id} className="card stack">
              <h2 className="card__title">
                <Link to={apiPath`/events/${e.id}`}>{e.title}</Link>
              </h2>
              <p className="muted">{e.orgName}</p>
              <EventTime iso={e.startsAt} timezone={e.timezone} />
              <p>{e.isOnline ? 'En ligne' : (e.venue ?? 'Lieu communiqué prochainement')}</p>
              <p className="row">
                <span>
                  à partir de <strong>{formatCents(e.fromPriceCents)}</strong>
                </span>
                <AvailabilityBadge value={e.coverAvailability} />
              </p>
            </li>
          ))}
        </ul>
      ) : null}
      {data && data.total > PAGE_SIZE ? (
        <nav className="row" aria-label="Pagination">
          <button type="button" className="btn btn--secondary" disabled={page <= 1} onClick={() => { setPage((p) => p - 1); }}>
            Précédent
          </button>
          <span>
            Page {page} / {Math.ceil(data.total / PAGE_SIZE)}
          </span>
          <button type="button" className="btn btn--secondary" disabled={page * PAGE_SIZE >= data.total} onClick={() => { setPage((p) => p + 1); }}>
            Suivant
          </button>
        </nav>
      ) : null}
    </section>
  );
}
