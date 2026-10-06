import { Link, useParams } from 'react-router';
import { apiPath } from '../../api/client';
import { useEventStats, useExportAttendees, useOrgEvent } from '../../api/hooks/org';
import { ErrorAlert } from '../../components/ErrorAlert';
import { EventTime } from '../../components/EventTime';
import { Gauge } from '../../components/Gauge';
import { Icon } from '../../components/Icon';
import { PageLoader } from '../../components/PageLoader';
import { useOnline } from '../../lib/hooks/useOnline';
import { useLocalNow } from '../../lib/hooks/useLocalNow';
import { EVENT_STATUS_LABELS } from '../../lib/labels';
import { lookup } from '../../lib/lookup';
import { formatCents } from '../../lib/money';
import { formatAgo } from '../../lib/time';

export function DashboardPage() {
  const { orgId = '', eventId = '' } = useParams();
  const event = useOrgEvent(orgId, eventId);
  const { data: stats, error, isPending, dataUpdatedAt, isError } = useEventStats(orgId, eventId);
  const exportCsv = useExportAttendees(orgId, eventId, event.data?.title);
  const online = useOnline();
  // Fraîcheur mesurée sur l'horloge LOCALE (dataUpdatedAt est local) : pas de décalage serveur ici.
  const now = useLocalNow(5000);
  const stale = !online || isError || (dataUpdatedAt > 0 && now - dataUpdatedAt > 20_000);
  const base = apiPath`/org/${orgId}/events/${eventId}`;
  const transfersToValidate = stats?.ordersByStatus.AWAITING_TRANSFER ?? 0;

  return (
    <section className="page">
      <nav aria-label="Fil d’Ariane" className="muted">
        <Link to={apiPath`/org/${orgId}`}>Événements</Link> › <Link to={base}>{event.data?.title ?? 'Événement'}</Link>
      </nav>
      <div className="stack stack--sm">
        <h1>{event.data?.title ?? 'Ventes en temps réel'}</h1>
        {event.data ? (
          <p className="row">
            <span className="badge badge--info">{lookup(EVENT_STATUS_LABELS, event.data.status) ?? 'Statut inconnu'}</span>
            <EventTime iso={event.data.startsAt} timezone={event.data.timezone} />
          </p>
        ) : null}
      </div>
      <div className="row">
        <button type="button" className="btn btn--secondary btn--small" disabled={exportCsv.isPending} onClick={() => exportCsv.mutate()}>
          <Icon name="download" size="sm" /> {exportCsv.isPending ? 'Export…' : 'Exporter les participants'}
        </button>
        <Link className="btn btn--secondary btn--small" to={base}>
          <Icon name="settings" size="sm" /> Modifier
        </Link>
        <Link className="btn btn--secondary btn--small" to={`${base}#titre-annulation`}>
          Reporter ou annuler
        </Link>
      </div>
      <ErrorAlert error={exportCsv.error} />
      <h2 className="visually-hidden">Ventes en temps réel</h2>
      <p className={stale ? 'alert alert--warning' : 'live'} role="status" aria-live="off">
        {stale ? <strong>{online ? 'Données non rafraîchies' : 'Hors-ligne'} — </strong> : 'En direct · '}
        {dataUpdatedAt > 0 ? `mis à jour ${formatAgo(dataUpdatedAt, now)}` : 'chargement…'}
      </p>
      {isPending ? <PageLoader shape="table" /> : null}
      {error && !stats ? <ErrorAlert error={error} /> : null}
      {stats ? (
        <>
          <div className="kpis">
            <div className="kpi">
              <span className="kpi__label">Vendues</span>
              <span className="kpi__value">{stats.totals.sold}</span>
              <span className="kpi__note">sur {stats.totals.capacity} places</span>
            </div>
            <div className="kpi">
              <span className="kpi__label">En attente</span>
              <span className="kpi__value">{stats.totals.held}</span>
              <span className="kpi__note">paiement ou virement</span>
            </div>
            <div className="kpi">
              <span className="kpi__label">Restantes</span>
              <span className="kpi__value">{stats.totals.remaining}</span>
            </div>
            <div className="kpi">
              <span className="kpi__label">Scannées</span>
              <span className="kpi__value">{stats.totals.checkedIn}</span>
              <span className="kpi__note">entrées</span>
            </div>
            <div className="kpi">
              <span className="kpi__label">Encaissé</span>
              <span className="kpi__value">{formatCents(stats.totals.revenueCents)}</span>
              <span className="kpi__note">net, dont {formatCents(stats.totals.serviceFeeCents)} de frais</span>
            </div>
          </div>

          <section className="card stack" aria-labelledby="titre-types">
            <h2 id="titre-types">Ventes par type de place</h2>
            <p className="gauge-legend">
              <span>■ Vendues</span>
              <span>▨ En attente de paiement</span>
            </p>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Type</th>
                    <th scope="col" className="num">
                      Vendues
                    </th>
                    <th scope="col" className="num">
                      En attente
                    </th>
                    <th scope="col" className="num">
                      Restantes
                    </th>
                    <th scope="col" className="num">
                      Scannées
                    </th>
                    <th scope="col" className="num">
                      Encaissé
                    </th>
                    <th scope="col" className="num">
                      Remboursé
                    </th>
                    <th scope="col">Remplissage</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.ticketTypes.map((t) => (
                    <tr key={t.ticketTypeId}>
                      <th scope="row">{t.name}</th>
                      <td className="num">
                        {t.sold} / {t.capacity}
                      </td>
                      <td className="num">{t.held}</td>
                      <td className="num">{t.remaining}</td>
                      <td className="num">{t.checkedIn}</td>
                      <td className="num">{formatCents(t.revenueCents)}</td>
                      <td className="num">{formatCents(t.refundedCents)}</td>
                      <td>
                        <Gauge capacity={t.capacity} sold={t.sold} pending={t.held} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <div className="grid-2">
            <section className="card stack" aria-labelledby="titre-virements">
              <h2 id="titre-virements">Virements à valider</h2>
              <p>
                <strong className="tabular">{transfersToValidate}</strong> commande{transfersToValidate > 1 ? 's' : ''} en attente de virement.
              </p>
              <Link to={`${base}/orders`}>Tout voir</Link>
            </section>
            <section className="card stack" aria-labelledby="titre-rembourser">
              <h2 id="titre-rembourser">Remboursements à effectuer</h2>
              {stats.totals.refundsToProcess > 0 ? (
                <p className="alert alert--warning" role="alert">
                  <Icon name="refund" />
                  <span>
                    <strong>
                      {stats.totals.refundsToProcess} remboursement{stats.totals.refundsToProcess > 1 ? 's' : ''} à effectuer manuellement.
                    </strong>{' '}
                    <Link to={`${apiPath`/org/${orgId}/refunds`}?eventId=${encodeURIComponent(eventId)}`}>Voir les remboursements</Link>
                  </span>
                </p>
              ) : (
                <p className="muted">Aucun remboursement à effectuer.</p>
              )}
            </section>
          </div>
          <p className="muted">Liste d’attente : {stats.waitlistWaiting} personne{stats.waitlistWaiting > 1 ? 's' : ''} en attente.</p>
        </>
      ) : null}
    </section>
  );
}
