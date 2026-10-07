import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { apiPath } from '../../api/client';
import { useEvent } from '../../api/hooks/catalog';
import { useAcceptOffer, useLeaveWaitlist, useMyWaitlist } from '../../api/hooks/waitlist';
import { Countdown } from '../../components/Countdown';
import { ErrorAlert } from '../../components/ErrorAlert';
import { EventTime } from '../../components/EventTime';
import { Icon } from '../../components/Icon';
import { PageLoader } from '../../components/PageLoader';
import { estimateServiceFeeCents, formatCents } from '../../lib/money';
import { formatDate, formatTime } from '../../lib/time';
import { positionLabel } from '../../lib/waitlist';

/** Écran d'une inscription en liste d'attente : parcours, puis offre (anneau de temps, récapitulatif, accepter / laisser). */
export function WaitlistOfferPage() {
  const { entryId } = useParams();
  const navigate = useNavigate();
  const { data, error, isPending, refetch } = useMyWaitlist(true);
  const entry = data?.items.find((w) => w.id === entryId);
  const { data: event } = useEvent(entry?.eventId);
  const accept = useAcceptOffer();
  const leave = useLeaveWaitlist();
  const [left, setLeft] = useState(false);

  if (isPending) return <PageLoader shape="text" />;
  if (!entry) return error ? <ErrorAlert error={error} onRetry={() => void refetch()} /> : <p className="page">Cette inscription n’existe plus.</p>;

  const tt = event?.ticketTypes.find((t) => t.id === entry.ticketTypeId);
  // ESTIMATION (le montant définitif est celui de la commande créée par le serveur).
  const subtotal = tt ? tt.currentPriceCents * entry.quantity : null;
  const fee = subtotal !== null && event ? estimateServiceFeeCents(subtotal, event.rules.serviceFeeFixedCents, event.rules.serviceFeeBasisPoints) : null;
  const total = subtotal !== null && fee !== null ? subtotal + fee : null;
  const offered = entry.status === 'OFFERED' && entry.offerExpiresAt !== null && !left;
  const tz = event?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

  return (
    <section className="page narrow">
      <ol className="steps" aria-label="Votre parcours">
        <li data-done="true">Inscription le {formatDate(entry.createdAt, tz)}</li>
        <li data-done={entry.status !== 'WAITING' ? 'true' : undefined} aria-current={entry.status === 'WAITING' ? 'step' : undefined}>
          {entry.position ? `Vous êtes ${positionLabel(entry.position)}` : 'Dans la file'}
        </li>
        <li aria-current={offered ? 'step' : undefined}>Une offre pour vous</li>
      </ol>

      {offered && entry.offerExpiresAt ? (
        <>
          <h1>{entry.quantity > 1 ? `${entry.quantity} places se sont libérées pour vous` : 'Une place s’est libérée pour vous'}</h1>
          <Countdown ring until={entry.offerExpiresAt} label="Temps restant pour accepter" onExpire={() => void refetch()} />
          <p className="notice">
            <Icon name="clock" />
            <span>
              Ces places sont réservées pour vous jusqu’à <strong>{formatTime(entry.offerExpiresAt, tz)}</strong>. Ensuite, elles seront proposées à la personne suivante.
            </span>
          </p>
        </>
      ) : entry.status === 'EXPIRED' ? (
        <>
          <h1>L’offre a expiré</h1>
          <p>Les places passent à la personne suivante. Vous restez inscrit·e sur la liste si d’autres se libèrent.</p>
        </>
      ) : left || entry.status === 'LEFT' ? (
        <>
          <h1>C’est noté, merci !</h1>
          <p>Les places passent à la personne suivante.</p>
        </>
      ) : (
        <h1>Vous êtes sur la liste d’attente</h1>
      )}

      <div className="card stack" data-theme="light">
        <p className="card__title">{entry.eventTitle}</p>
        {event ? <EventTime iso={event.startsAt} timezone={event.timezone} /> : null}
        {event && !event.isOnline && event.venue ? (
          <p className="event-card__meta">
            <Icon name="map-pin" size="sm" /> {event.venue}
          </p>
        ) : null}
        <div className="summary">
          <p className="summary__line">
            <span>
              {entry.quantity} × {entry.ticketTypeName}
            </span>
            <span>{subtotal !== null ? formatCents(subtotal) : ''}</span>
          </p>
          {fee !== null ? (
            <p className="summary__line">
              <span>Frais de service</span>
              <span>{formatCents(fee)}</span>
            </p>
          ) : null}
          {total !== null ? (
            <p className="summary__total">
              <span>Total estimé</span>
              <span className="summary__total-amount">{formatCents(total)}</span>
            </p>
          ) : null}
        </div>
      </div>

      <ErrorAlert error={accept.error ?? leave.error} />
      {offered ? (
        <div className="action-bar">
          <button
            type="button"
            className="btn btn--block"
            disabled={accept.isPending}
            onClick={() => accept.mutate(entry.id, { onSuccess: (order) => void navigate(apiPath`/orders/${order.id}`) })}
          >
            {total !== null ? `Accepter et payer ${formatCents(total)}` : 'Accepter et payer'}
          </button>
          <button
            type="button"
            className="btn btn--secondary btn--block"
            disabled={leave.isPending}
            onClick={() =>
              leave.mutate(entry.id, {
                onSuccess: () => {
                  setLeft(true);
                },
              })
            }
          >
            Je laisse ma place
          </button>
        </div>
      ) : (
        <Link to="/me/tickets">Retour à mes billets</Link>
      )}
    </section>
  );
}
