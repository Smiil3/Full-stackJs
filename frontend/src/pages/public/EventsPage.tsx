import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { useEvents } from '../../api/hooks/catalog';
import { apiPath } from '../../api/client';
import type { EventsQuery } from '../../api/types';
import { AvailabilityBadge } from '../../components/AvailabilityBadge';
import { ErrorAlert } from '../../components/ErrorAlert';
import { Icon } from '../../components/Icon';
import { PageLoader } from '../../components/PageLoader';
import { Poster } from '../../components/Poster';
import { formatPrice } from '../../lib/money';
import { formatDateTime } from '../../lib/time';

const PAGE_SIZE = 12;
type Filter = 'all' | 'week' | 'month' | 'online';
const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: 'Tout' },
  { key: 'week', label: 'Cette semaine' },
  { key: 'month', label: 'Ce mois-ci' },
  { key: 'online', label: 'En ligne' },
];
const DAY = 86_400_000;

/** Bornes de période envoyées à l'API (à partir de maintenant, à la minute). */
function periodRange(f: Filter): { from: string; to: string } | null {
  if (f !== 'week' && f !== 'month') return null;
  const from = Math.floor(Date.now() / 60_000) * 60_000;
  return { from: new Date(from).toISOString(), to: new Date(from + (f === 'week' ? 7 : 31) * DAY).toISOString() };
}

export function EventsPage() {
  const [page, setPage] = useState(1);
  const [filter, setFilter] = useState<Filter>('all');
  const [range, setRange] = useState<{ from: string; to: string } | null>(null);
  const [search, setSearch] = useState('');
  // Filtres de période : bornes envoyées à l'API (from / to), fixées au clic (cache stable).
  const query = useMemo<EventsQuery>(() => (range ? { page, pageSize: PAGE_SIZE, ...range } : { page, pageSize: PAGE_SIZE }), [range, page]);
  const choose = (f: Filter) => {
    setFilter(f);
    setPage(1);
    setRange(periodRange(f));
  };
  const { data, error, isPending, isPlaceholderData, refetch } = useEvents(query);
  const term = search.trim().toLocaleLowerCase('fr');
  const items = (data?.items ?? []).filter(
    (e) => (filter !== 'online' || e.isOnline) && (!term || [e.title, e.orgName, e.venue ?? ''].some((v) => v.toLocaleLowerCase('fr').includes(term))),
  );

  return (
    <section className="page">
      <div className="stack stack--sm">
        <h1>La nuit, côté Garonne.</h1>
        <p className="muted">Concerts et soirées du collectif et de ses partenaires, à Bordeaux et en ligne.</p>
      </div>
      <label className="search">
        <Icon name="search" />
        <span className="visually-hidden">Rechercher un événement</span>
        <input type="search" placeholder="Rechercher un événement" value={search} onChange={(e) => setSearch(e.target.value)} />
      </label>
      <div className="chips" role="group" aria-label="Filtrer les événements">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            className="chip"
            aria-pressed={filter === f.key}
            onClick={() => {
              choose(f.key);
            }}
          >
            {f.label}
          </button>
        ))}
      </div>
      <div className="section-head">
        <h2>Prochainement</h2>
        {data ? (
          <span className="muted" aria-live="polite">
            {items.length} événement{items.length > 1 ? 's' : ''}
          </span>
        ) : null}
      </div>
      {isPending ? <PageLoader /> : null}
      <ErrorAlert error={error} onRetry={() => void refetch()} />
      {data && items.length === 0 ? (
        <div className="empty-state">
          <Icon name="calendar-x" />
          <p className="empty-state__title">Rien de prévu avec ce filtre pour l’instant</p>
          <p className="muted">Essayez un autre filtre, ou revenez bientôt.</p>
          <button
            type="button"
            className="btn btn--secondary"
            onClick={() => {
              choose('all');
              setSearch('');
            }}
          >
            Voir tous les événements
          </button>
        </div>
      ) : null}
      {data && items.length > 0 ? (
        <ul className="list-reset grid-cards" aria-busy={isPlaceholderData}>
          {items.map((e) => (
            <li key={e.id}>
              {/* Toute la carte est un lien ; son nom accessible est le titre. */}
              <Link className="card event-card" to={apiPath`/events/${e.id}`} aria-labelledby={`ev-${e.id}`}>
                <Poster id={e.id} iso={e.startsAt} timeZone={e.timezone} />
                <span className="event-card__body">
                  <AvailabilityBadge value={e.coverAvailability} />
                  <span id={`ev-${e.id}`} className="card__title">
                    {e.title}
                  </span>
                  <span className="muted">{e.orgName}</span>
                  <span className="event-card__meta">
                    <Icon name="clock" size="sm" />
                    {formatDateTime(e.startsAt, e.timezone)}
                  </span>
                  <span className="event-card__meta">
                    <Icon name={e.isOnline ? 'globe' : 'map-pin'} size="sm" />
                    {e.isOnline ? 'En ligne' : (e.venue ?? 'Lieu communiqué prochainement')}
                  </span>
                  <span className="event-card__price">
                    à partir de <strong>{formatPrice(e.fromPriceCents)}</strong>
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
      {data && data.total > PAGE_SIZE ? (
        <nav className="row row--between" aria-label="Pagination">
          <button type="button" className="btn btn--secondary btn--small" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            Précédent
          </button>
          <span>
            Page {page} / {Math.ceil(data.total / PAGE_SIZE)}
          </span>
          <button type="button" className="btn btn--secondary btn--small" disabled={page * PAGE_SIZE >= data.total} onClick={() => setPage((p) => p + 1)}>
            Suivant
          </button>
        </nav>
      ) : null}
    </section>
  );
}
