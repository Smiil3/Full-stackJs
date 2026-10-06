import { useNavigate } from 'react-router';
import { apiPath } from '../../api/client';
import { useAcceptOffer, useLeaveWaitlist, useMyWaitlist } from '../../api/hooks/waitlist';
import { Countdown } from '../../components/Countdown';
import { ErrorAlert } from '../../components/ErrorAlert';
import { lookup } from '../../lib/lookup';

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
          <li key={w.id} className="card stack">
            <p>
              <strong>{w.eventTitle}</strong> — {w.quantity} × {w.ticketTypeName}
            </p>
            {w.status === 'WAITING' ? (
              <p>
                En attente{w.position ? ` — position ${w.position}` : ''}. Vous serez prévenu·e par email si des places se libèrent.
              </p>
            ) : w.status === 'OFFERED' && w.offerExpiresAt ? (
              <>
                <p className="alert alert--success">Des places sont disponibles pour vous !</p>
                <Countdown until={w.offerExpiresAt} label="Offre valable encore" />
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
            {w.status === 'WAITING' || w.status === 'OFFERED' ? (
              <button type="button" className="btn btn--secondary btn--small" disabled={leave.isPending} onClick={() => leave.mutate(w.id)}>
                Quitter la liste d’attente
              </button>
            ) : null}
          </li>
        ))}
      </ul>
      <ErrorAlert error={accept.error ?? leave.error} />
    </section>
  );
}
