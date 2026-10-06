import { Link, useNavigate } from 'react-router';
import { apiPath } from '../../api/client';
import { useAcceptOffer, useLeaveWaitlist, useMyWaitlist } from '../../api/hooks/waitlist';
import { ErrorAlert } from '../../components/ErrorAlert';
import { Icon } from '../../components/Icon';
import { lookup } from '../../lib/lookup';
import { positionLabel } from '../../lib/waitlist';

const STATUS: Record<string, string> = { CONVERTED: 'Offre acceptée', EXPIRED: 'Offre expirée', LEFT: 'Inscription retirée' };

export function WaitlistSection() {
  const { data } = useMyWaitlist(true);
  const leave = useLeaveWaitlist();
  const accept = useAcceptOffer();
  const navigate = useNavigate();
  const items = data?.items ?? [];
  if (items.length === 0) return null;
  return (
    <section className="stack" aria-labelledby="titre-attente">
      <h2 id="titre-attente">Mes listes d’attente</h2>
      <ul className="list-reset stack">
        {items.map((w) => (
          <li key={w.id} className={`card stack${w.status === 'OFFERED' ? ' card--attention' : ''}`}>
            <p className="muted">LISTE D’ATTENTE</p>
            <p className="card__title">{w.eventTitle}</p>
            {w.status === 'WAITING' ? (
              <>
                <p>
                  {w.position ? (
                    <>
                      Vous êtes <strong>{positionLabel(w.position)}</strong>{' '}
                    </>
                  ) : (
                    'Vous êtes inscrit·e '
                  )}
                  pour {w.quantity} place{w.quantity > 1 ? 's' : ''} en {w.ticketTypeName}.
                </p>
                <p className="muted">Si des places se libèrent, nous vous prévenons par e-mail. Vous aurez alors un temps limité pour accepter.</p>
              </>
            ) : w.status === 'OFFERED' && w.offerExpiresAt ? (
              <>
                <p className="waitlist-offer__time">
                  <Icon name="hourglass" size="sm" /> {w.quantity > 1 ? `${w.quantity} places se sont libérées pour vous` : 'Une place s’est libérée pour vous'} ({w.ticketTypeName})
                </p>
                <button
                  type="button"
                  className="btn"
                  disabled={accept.isPending}
                  onClick={() => accept.mutate(w.id, { onSuccess: (order) => void navigate(apiPath`/orders/${order.id}`) })}
                >
                  Accepter et payer
                </button>
              </>
            ) : (
              <p className="muted">{lookup(STATUS, w.status) ?? 'Statut inconnu'}</p>
            )}
            <div className="row">
              {w.status === 'WAITING' || w.status === 'OFFERED' ? (
                <Link to={apiPath`/waitlist/${w.id}`}>{w.status === 'OFFERED' ? 'Voir l’offre' : 'Voir le détail'}</Link>
              ) : null}
              {w.status === 'WAITING' || w.status === 'OFFERED' ? (
                <button type="button" className="btn btn--ghost btn--small" disabled={leave.isPending} onClick={() => leave.mutate(w.id)}>
                  Quitter la liste d’attente
                </button>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
      <ErrorAlert error={accept.error ?? leave.error} />
    </section>
  );
}
