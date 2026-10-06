import { Link, useLocation } from 'react-router';
import { apiPath } from '../api/client';
import { useMyWaitlist } from '../api/hooks/waitlist';
import { useAuth } from '../auth/AuthContext';
import { useNow } from '../lib/hooks/useNow';

/** Bandeau global : une offre de la liste d'attente est en cours (réponse limitée dans le temps). */
export function WaitlistOfferBanner() {
  const { status } = useAuth();
  const { data } = useMyWaitlist(status === 'authenticated');
  const now = useNow(30_000);
  const { pathname } = useLocation();
  const offer = data?.items.find((w) => w.status === 'OFFERED' && w.offerExpiresAt);
  if (!offer?.offerExpiresAt || pathname.startsWith('/waitlist/')) return null;
  const remaining = Date.parse(offer.offerExpiresAt) - now;
  return (
    <div className="page page--flush">
      <div className="waitlist-offer" role="status">
        <p>
          <strong>
            {offer.quantity > 1 ? `${offer.quantity} places se sont libérées pour vous` : 'Une place s’est libérée pour vous'}
          </strong>{' '}
          — Places disponibles : {offer.quantity} × {offer.ticketTypeName}, {offer.eventTitle}
        </p>
        <p className="waitlist-offer__time">{remaining > 0 ? `Encore ${Math.ceil(remaining / 60_000)} min pour répondre` : 'Délai de réponse écoulé'}</p>
        <Link className="btn btn--small" to={apiPath`/waitlist/${offer.id}`}>
          Voir l’offre
        </Link>
      </div>
    </div>
  );
}
