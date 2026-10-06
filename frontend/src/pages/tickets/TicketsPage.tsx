import { useEffect, useMemo, useRef, useState } from 'react';
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
  const { status, revalidate, revalidating } = useAuth();
  const { data, error, isPending } = useMyTickets();
  // Page de QR redevenue visible (appareil prêté, onglet repris) : session revérifiée, QR masqués entre-temps.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') void revalidate();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [revalidate]);
  const [shownId, setShownId] = useState<string | null>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const groups = useMemo(() => groupByEvent(data?.tickets ?? []), [data]);
  // Toujours la version À JOUR du billet : s'il est utilisé, annulé ou a disparu, le plein écran se ferme.
  const shown = shownId ? data?.tickets.find((t) => t.id === shownId && t.status === 'VALID') : undefined;
  const wasShown = useRef(false);
  useEffect(() => {
    if (shown) {
      wasShown.current = true;
    } else if (wasShown.current) {
      wasShown.current = false;
      openerRef.current?.focus(); // retour du focus sur le bouton d'ouverture
    }
  }, [shown]);
  const open = (t: Ticket, opener: HTMLElement) => {
    openerRef.current = opener;
    setShownId(t.id);
  };

  return (
    <>
      {shown && !revalidating ? (
        <QrFullscreen
          value={shown.qrPayload}
          title={shown.event.title}
          subtitle={`${shown.ticketTypeName} — ${formatDateTime(shown.event.startsAt, shown.event.timezone)}`}
          onClose={() => setShownId(null)}
        />
      ) : null}
      {/* Liste gardée montée (inerte sous le plein écran) : le focus peut revenir sur le bouton d'ouverture. */}
      <section className="page" inert={shown !== undefined && !revalidating}>
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
                    {t.status === 'VALID' && revalidating ? (
                      <p className="muted" role="status">
                        Vérification de la session…
                      </p>
                    ) : t.status === 'VALID' ? (
                      <>
                        <QrCode value={t.qrPayload} size={240} label={`QR code du billet ${t.ticketTypeName}`} />
                        <button type="button" className="btn" onClick={(e) => open(t, e.currentTarget)}>
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
    </>
  );
}
