import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { apiPath } from '../../api/client';
import { useOrgEvents } from '../../api/hooks/org';
import type { EventStatus } from '../../api/types';
import { ErrorAlert } from '../../components/ErrorAlert';
import { PageLoader } from '../../components/PageLoader';
import { EVENT_STATUS_LABELS } from '../../lib/labels';
import { lookup } from '../../lib/lookup';
import { formatDateTime } from '../../lib/time';

const FILTERS: { value: EventStatus | undefined; label: string }[] = [
  { value: undefined, label: 'Tous' },
  { value: 'DRAFT', label: 'Brouillons' },
  { value: 'PUBLISHED', label: 'Publiés' },
  { value: 'CANCELLED', label: 'Annulés' },
];

export function OrgEventsPage() {
  const { orgId = '' } = useParams();
  const [status, setStatus] = useState<EventStatus | undefined>(undefined);
  const [page, setPage] = useState(1);
  const { data, error, isPending } = useOrgEvents(orgId, status, page);
  return (
    <section className="page">
      <div className="row row--between">
        <h1 className="m-0">Événements</h1>
        <Link className="btn" to={apiPath`/org/${orgId}/events/new`}>
          Créer un événement
        </Link>
      </div>
      <div className="row" role="group" aria-label="Filtrer par statut">
        {FILTERS.map((f) => (
          <button
            key={f.label}
            type="button"
            className={`btn btn--small ${status === f.value ? '' : 'btn--secondary'}`}
            aria-pressed={status === f.value}
            onClick={() => {
              setStatus(f.value);
              setPage(1);
            }}
          >
            {f.label}
          </button>
        ))}
      </div>
      {isPending ? <PageLoader /> : null}
      <ErrorAlert error={error} />
      {data?.items.length === 0 ? <p>Aucun événement.</p> : null}
      <ul className="list-reset stack">
        {data?.items.map((e) => {
          const sold = e.ticketTypes.reduce((s, t) => s + t.sold, 0);
          const capacity = e.ticketTypes.reduce((s, t) => s + t.capacity, 0);
          return (
            <li key={e.id} className="card stack">
              <h2 className="card__title">
                <Link to={apiPath`/org/${orgId}/events/${e.id}`}>{e.title}</Link>
              </h2>
              <p className="row">
                <span className={`badge badge--${e.status === 'PUBLISHED' ? 'available' : e.status === 'DRAFT' ? 'low' : 'sold_out'}`}>{lookup(EVENT_STATUS_LABELS, e.status)}</span>
                <span className="muted">{formatDateTime(e.startsAt, e.timezone)}</span>
              </p>
              <p>
                {sold} / {capacity} places vendues
              </p>
            </li>
          );
        })}
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
