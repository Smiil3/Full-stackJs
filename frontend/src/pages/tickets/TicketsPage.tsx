import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { apiPath } from '../../api/client';
import { useMyTickets } from '../../api/hooks/tickets';
import type { Ticket } from '../../api/types';
import { useAuth } from '../../auth/AuthContext';
import { EventTime } from '../../components/EventTime';
import { ErrorAlert } from '../../components/ErrorAlert';
import { PageLoader } from '../../components/PageLoader';
import { QrCode } from '../../components/QrCode';
import { QrFullscreen } from '../../components/QrFullscreen';
import { formatDateTime } from '../../lib/time';
import { WaitlistSection } from './WaitlistSection';

function groupByEvent(tickets: Ticket[]) {
  const map = new Map<string, Ticket[]>();
  for (const t of tickets) map.set(t.event.id, [...(map.get(t.event.id) ?? []), t]);
  return [...map.values()];
}

export function TicketsPage() {
  const { status } = useAuth();
  const { data, error, isPending } = useMyTickets();
  const [shown, setShown] = useState<Ticket | null>(null);
  const groups = useMemo(() => groupByEvent(data?.tickets ?? []), [data]);

  if (shown) {
    return (
      <QrFullscreen
        value={shown.qrPayload}
        title={shown.event.title}
        subtitle={`${shown.ticketTypeName} — ${formatDateTime(shown.event.startsAt, shown.event.timezone)}`}
        onClose={() => setShown(null)}
      />
    );
  }

  return (
    <section className="page">
      <h1>Mes billets</h1>
      {data?.offline ? (
        <p className="alert alert--warning" role="status">
          Hors-ligne : billets enregistrés sur cet appareil{data.savedAt ? ` le ${formatDateTime(data.savedAt, Intl.DateTimeFormat().resolvedOptions().timeZone)}` : ''}. Leur statut peut avoir changé.
        </p>
      ) : null}
      {isPending ? <PageLoader /> : null}
      {error instanceof Error && error.message === 'offline-empty' ? (
        <p className="alert alert--warning">Vous êtes hors-ligne et aucun billet n’est encore enregistré sur cet appareil.</p>
      ) : (
        <ErrorAlert error={error} />
      )}
      {data?.tickets.length === 0 ? (
        <p>
          Vous n’avez pas encore de billet. <Link to="/">Voir les événements</Link>
        </p>
      ) : null}
      {groups.map((tickets) => {
        const ev = tickets[0]?.event;
        if (!ev) return null;
        return (
          <article key={ev.id} className="stack">
            <h2>{ev.title}</h2>
            <EventTime iso={ev.startsAt} timezone={ev.timezone} />
            <p className="muted">{ev.isOnline ? 'En ligne' : (ev.venue ?? '')}</p>
            <ul className="list-reset grid-cards">
              {tickets.map((t, i) => (
                <li key={t.id} className="card stack ticket">
                  <p className="row">
                    <strong>{t.ticketTypeName}</strong>
                    <span className="muted">
                      Billet {i + 1}/{tickets.length}
                    </span>
                  </p>
                  {t.status === 'VALID' ? (
                    <>
                      <QrCode value={t.qrPayload} size={240} label={`QR code du billet ${t.ticketTypeName}`} />
                      <button type="button" className="btn" onClick={() => setShown(t)}>
                        Afficher en plein écran
                      </button>
                    </>
                  ) : t.status === 'USED' ? (
                    <p className="badge badge--low">Utilisé{t.usedAt ? ` le ${formatDateTime(t.usedAt, ev.timezone)}` : ''}</p>
                  ) : (
                    <p className="badge badge--sold_out">Annulé</p>
                  )}
                  <Link to={apiPath`/orders/${t.orderId}`}>Voir la commande</Link>
                </li>
              ))}
            </ul>
          </article>
        );
      })}
      {status === 'authenticated' ? <WaitlistSection /> : null}
    </section>
  );
}
