import { Link, useParams } from 'react-router';
import { apiPath } from '../../api/client';
import { useEventStats, useOrgEvent } from '../../api/hooks/org';
import { ErrorAlert } from '../../components/ErrorAlert';
import { PageLoader } from '../../components/PageLoader';
import { useOnline } from '../../lib/hooks/useOnline';
import { useLocalNow } from '../../lib/hooks/useLocalNow';
import { ORDER_STATUS_LABELS } from '../../lib/labels';
import { formatCents } from '../../lib/money';
import { formatAgo } from '../../lib/time';

function Fill({ sold, held, capacity, label }: { sold: number; held: number; capacity: number; label: string }) {
  const pct = capacity > 0 ? Math.min(100, Math.round(((sold + held) / capacity) * 100)) : 0;
  return (
    <div className="fill">
      <meter className="fill__meter" min={0} max={capacity || 1} low={capacity * 0.7} high={capacity * 0.9} optimum={capacity} value={sold + held} aria-label={`Remplissage ${label}`} />
      <span className="muted">{pct} % rempli (vendues + en attente)</span>
    </div>
  );
}

export function DashboardPage() {
  const { orgId = '', eventId = '' } = useParams();
  const event = useOrgEvent(orgId, eventId);
  const { data: stats, error, isPending, dataUpdatedAt, isError } = useEventStats(orgId, eventId);
  const online = useOnline();
  // Fraîcheur mesurée sur l'horloge LOCALE (dataUpdatedAt est local) : pas de décalage serveur ici.
  const now = useLocalNow(5000);
  const stale = !online || isError || (dataUpdatedAt > 0 && now - dataUpdatedAt > 20_000);

  return (
    <section className="page">
      <p>
        <Link to={apiPath`/org/${orgId}/events/${eventId}`}>← {event.data?.title ?? 'Événement'}</Link>
      </p>
      <h1>Ventes en temps réel</h1>
      <p className={`row ${stale ? 'alert alert--warning' : 'muted'}`} role="status" aria-live="off">
        {stale ? <strong>{online ? 'Données non rafraîchies' : 'Hors-ligne'} — </strong> : null}
        {dataUpdatedAt > 0 ? `Mis à jour ${formatAgo(dataUpdatedAt, now)}` : 'Chargement…'} · actualisation automatique toutes les 5 s
      </p>
      {isPending ? <PageLoader /> : null}
      {error && !stats ? <ErrorAlert error={error} /> : null}
      {stats ? (
        <>
          {stats.totals.refundsToProcess > 0 ? (
            <p className="alert alert--warning" role="alert">
              <strong>
                {stats.totals.refundsToProcess} remboursement{stats.totals.refundsToProcess > 1 ? 's' : ''} à effectuer manuellement.
              </strong>{' '}
              <Link to={`${apiPath`/org/${orgId}/refunds`}?eventId=${encodeURIComponent(eventId)}`}>Voir les remboursements</Link>
            </p>
          ) : null}
          <div className="kpis">
            <div className="kpi">
              <span className="kpi__label">Vendues</span>
              <span className="kpi__value">
                {stats.totals.sold} / {stats.totals.capacity}
              </span>
            </div>
            <div className="kpi">
              <span className="kpi__label">En attente de paiement</span>
              <span className="kpi__value">{stats.totals.held}</span>
            </div>
            <div className="kpi">
              <span className="kpi__label">Restantes</span>
              <span className="kpi__value">{stats.totals.remaining}</span>
            </div>
            <div className="kpi">
              <span className="kpi__label">Entrées scannées</span>
              <span className="kpi__value">{stats.totals.checkedIn}</span>
            </div>
            <div className="kpi">
              <span className="kpi__label">Encaissé (net)</span>
              <span className="kpi__value">{formatCents(stats.totals.revenueCents)}</span>
            </div>
            <div className="kpi">
              <span className="kpi__label">Frais de service</span>
              <span className="kpi__value">{formatCents(stats.totals.serviceFeeCents)}</span>
            </div>
          </div>
          <Fill sold={stats.totals.sold} held={stats.totals.held} capacity={stats.totals.capacity} label="total" />
          <div className="table-wrap">
            <table className="table">
              <caption className="visually-hidden">Ventes par type de place</caption>
              <thead>
                <tr>
                  <th scope="col">Type</th>
                  <th scope="col">Vendues</th>
                  <th scope="col">En attente</th>
                  <th scope="col">Restantes</th>
                  <th scope="col">Scannées</th>
                  <th scope="col">Encaissé</th>
                  <th scope="col">Remboursé</th>
                </tr>
              </thead>
              <tbody>
                {stats.ticketTypes.map((t) => (
                  <tr key={t.ticketTypeId}>
                    <th scope="row">
                      {t.name}
                      <Fill sold={t.sold} held={t.held} capacity={t.capacity} label={t.name} />
                    </th>
                    <td>
                      {t.sold} / {t.capacity}
                    </td>
                    <td>{t.held}</td>
                    <td>{t.remaining}</td>
                    <td>{t.checkedIn}</td>
                    <td>{formatCents(t.revenueCents)}</td>
                    <td>{formatCents(t.refundedCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <h2>Commandes</h2>
          <ul className="list-reset row">
            {(Object.keys(ORDER_STATUS_LABELS) as (keyof typeof ORDER_STATUS_LABELS)[]).map((s) => (
              <li key={s} className="card">
                {ORDER_STATUS_LABELS[s]} : <strong>{stats.ordersByStatus[s]}</strong>
              </li>
            ))}
            <li className="card">
              Liste d’attente : <strong>{stats.waitlistWaiting}</strong>
            </li>
          </ul>
        </>
      ) : null}
    </section>
  );
}
