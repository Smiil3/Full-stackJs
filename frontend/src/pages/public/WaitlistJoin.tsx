import { useState } from 'react';
import { Link } from 'react-router';
import { useJoinWaitlist } from '../../api/hooks/waitlist';
import { apiPath } from '../../api/client';
import { isApiError } from '../../api/errors';
import { ErrorAlert } from '../../components/ErrorAlert';
import type { TicketTypePublic } from '../../api/types';
import { useAuth } from '../../auth/AuthContext';
import { loginPathWithNext } from '../../auth/safeRedirect';

export function WaitlistJoin({ eventId, ticketType, maxPerOrder }: { eventId: string; ticketType: TicketTypePublic; maxPerOrder: number }) {
  const { status, user } = useAuth();
  const join = useJoinWaitlist();
  const [qty, setQty] = useState(1);
  const selectId = `attente-${ticketType.id}`;

  if (status !== 'authenticated' || !user) {
    return (
      <Link className="btn btn--secondary" to={loginPathWithNext(apiPath`/events/${eventId}`)}>
        Se connecter pour rejoindre la liste d’attente
      </Link>
    );
  }
  if (join.isSuccess) {
    return (
      <p className="alert alert--success" role="status">
        Vous êtes inscrit·e{join.data.position ? ` (position ${join.data.position})` : ''}. Vous serez prévenu·e par email si des places se libèrent.
        {' '}
        <Link to="/me/tickets">Suivre ma liste d’attente</Link>
      </p>
    );
  }
  return (
    <div className="stack stack--sm">
      <p>
        <strong>Toutes les places sont parties, mais tout n’est pas perdu.</strong>
      </p>
      <p className="muted m-0 waitlist-help">
        Liste d’attente par ordre d’inscription. Quand des places se libèrent, la première personne de la file est servie en priorité et reçoit un email : elle a alors un
        délai limité pour accepter, sinon la suivante est servie. Le nombre maximum de places par personne s’applique aussi à l’acceptation.
      </p>
      <div className="row">
        <div className="field">
          <label htmlFor={selectId}>Places souhaitées</label>
          <select id={selectId} value={qty} onChange={(e) => { setQty(Number(e.target.value)); }}>
            {Array.from({ length: maxPerOrder }, (_, i) => i + 1).map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </div>
        <button
          type="button"
          className="btn btn--secondary"
          disabled={join.isPending || !user.emailVerified}
          onClick={() => { join.mutate({ eventId, ticketTypeId: ticketType.id, quantity: qty }); }}
        >
          {join.isPending ? 'Inscription…' : 'Rejoindre la liste d’attente'}
        </button>
      </div>
      {!user.emailVerified ? <p className="muted">Confirmez votre email pour vous inscrire.</p> : null}
      {isApiError(join.error) && join.error.code === 'CONFLICT' ? (
        <p className="alert alert--warning" role="alert">
          Vous avez laissé passer deux offres de places pour cet événement : la liste d’attente ne vous est plus ouverte, pour que d’autres puissent en profiter.
        </p>
      ) : (
        <ErrorAlert error={join.error} />
      )}
    </div>
  );
}
