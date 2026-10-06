import { Link } from 'react-router';
import { useMyWaitlist } from '../api/hooks/waitlist';
import { useAuth } from '../auth/AuthContext';
import { Countdown } from './Countdown';

/** Bandeau global : une offre de la liste d'attente est en cours (réponse limitée dans le temps). */
export function WaitlistOfferBanner() {
  const { status } = useAuth();
  const { data } = useMyWaitlist(status === 'authenticated');
  const offer = data?.items.find((w) => w.status === 'OFFERED' && w.offerExpiresAt);
  if (!offer?.offerExpiresAt) return null;
  return (
    <div className="banner-offer" role="status">
      <p>
        <strong>Places disponibles :</strong> {offer.quantity} × {offer.ticketTypeName} — {offer.eventTitle}
      </p>
      <Countdown until={offer.offerExpiresAt} label="Répondez avant" />
      <Link className="btn btn--small" to="/me/tickets#titre-attente">
        Voir l’offre
      </Link>
    </div>
  );
}
