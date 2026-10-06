import { useId, useMemo, useState, type SubmitEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { useResendVerification } from '../../api/hooks/account';
import { useCreateOrder } from '../../api/hooks/orders';
import { apiPath } from '../../api/client';
import { errorMessage, isApiError } from '../../api/errors';
import type { EventPublic, PaymentMethod } from '../../api/types';
import { useAuth } from '../../auth/AuthContext';
import { loginPathWithNext } from '../../auth/safeRedirect';
import { AvailabilityBadge } from '../../components/AvailabilityBadge';
import { estimateServiceFeeCents, formatBasisPoints, formatCents } from '../../lib/money';
import { useNow } from '../../lib/hooks/useNow';
import { formatDateTime } from '../../lib/time';
import { WaitlistJoin } from './WaitlistJoin';

export function OrderForm({ event, onStale }: { event: EventPublic; onStale: () => void }) {
  const { user, status } = useAuth();
  const navigate = useNavigate();
  const createOrder = useCreateOrder();
  const resend = useResendVerification();
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [method, setMethod] = useState<PaymentMethod>('CARD');
  const methodName = useId();
  const { rules } = event;
  const now = useNow(30_000);

  const totalQty = Object.values(quantities).reduce((s, q) => s + q, 0);
  const subtotal = event.ticketTypes.reduce((s, t) => s + t.currentPriceCents * (quantities[t.id] ?? 0), 0);
  const fee = totalQty > 0 ? estimateServiceFeeCents(subtotal, rules.serviceFeeFixedCents, rules.serviceFeeBasisPoints) : 0;
  const effectiveMethod: PaymentMethod = rules.transferEnabled ? method : 'CARD';

  const items = useMemo(
    () => Object.entries(quantities).filter(([, q]) => q > 0).map(([ticketTypeId, quantity]) => ({ ticketTypeId, quantity })),
    [quantities],
  );

  const soldOutName = (() => {
    const e = createOrder.error;
    if (!isApiError(e) || e.code !== 'SOLD_OUT') return null;
    return event.ticketTypes.find((t) => t.id === e.details?.ticketTypeId)?.name ?? null;
  })();

  const submit = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (createOrder.isPending || items.length === 0) return;
    createOrder.mutate(
      { eventId: event.id, paymentMethod: effectiveMethod, items },
      {
        onSuccess: (order) => {
          void navigate(order.status === 'PAID' ? '/me/tickets' : apiPath`/orders/${order.id}`);
        },
        onError: (err) => {
          if (isApiError(err) && (err.code === 'SOLD_OUT' || err.code === 'SALES_CLOSED')) onStale();
        },
      },
    );
  };

  const cancelDeadline = new Date(Date.parse(event.startsAt) - rules.cancellationDeadlineHours * 3_600_000).toISOString();

  return (
    <form className="stack" onSubmit={submit} aria-labelledby="titre-places">
      <h2 id="titre-places">Places</h2>
      <ul className="list-reset stack">
        {event.ticketTypes.map((t) => {
          const current = quantities[t.id] ?? 0;
          const max = Math.max(0, rules.maxPerOrder - (totalQty - current));
          const selectId = `qte-${t.id}`;
          return (
            <li key={t.id} className="card stack">
              <div className="row row--between">
                <h3 className="m-0">{t.name}</h3>
                <AvailabilityBadge value={t.availability} />
              </div>
              {t.description ? <p className="pre-line">{t.description}</p> : null}
              <p>
                <strong>{formatCents(t.currentPriceCents)}</strong>
                {t.isEarly ? (
                  <>
                    <span className="price-old" aria-label={`au lieu de ${formatCents(t.regularPriceCents)}`}>
                      {formatCents(t.regularPriceCents)}
                    </span>
                    {t.earlyUntil ? <span className="muted"> — tarif early jusqu’au {formatDateTime(t.earlyUntil, event.timezone)}</span> : null}
                  </>
                ) : null}
              </p>
              {t.availability === 'SOLD_OUT' ? (
                rules.waitlistEnabled ? (
                  <WaitlistJoin eventId={event.id} ticketType={t} maxPerOrder={rules.maxPerOrder} />
                ) : (
                  <p className="muted">Complet.</p>
                )
              ) : event.salesOpen ? (
                <div className="field">
                  <label htmlFor={selectId}>Nombre de places « {t.name} »</label>
                  <select
                    id={selectId}
                    value={current}
                    onChange={(e) => {
                      setQuantities((q) => ({ ...q, [t.id]: Number(e.target.value) }));
                    }}
                  >
                    {Array.from({ length: Math.min(max, rules.maxPerOrder) + 1 }, (_, n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
      <p className="muted">Maximum {rules.maxPerOrder} place{rules.maxPerOrder > 1 ? 's' : ''} par commande, {rules.maxPerUser} par personne pour cet événement.</p>

      {event.salesOpen ? (
        <>
          <fieldset className="stack card">
            <legend>Paiement</legend>
            <label className="row">
              <input type="radio" name={methodName} value="CARD" checked={effectiveMethod === 'CARD'} onChange={() => { setMethod('CARD'); }} />
              Carte bancaire — places réservées {rules.cardHoldMinutes} min le temps du paiement
            </label>
            {rules.transferEnabled ? (
              <label className="row">
                <input type="radio" name={methodName} value="TRANSFER" checked={effectiveMethod === 'TRANSFER'} onChange={() => { setMethod('TRANSFER'); }} />
                Virement bancaire — {rules.transferHoldHours} h pour effectuer le virement, sinon les places sont libérées
              </label>
            ) : null}
          </fieldset>

          <section className="card stack" aria-labelledby="titre-recap" aria-live="polite">
            <h2 id="titre-recap" className="m-0">
              Récapitulatif
            </h2>
            <dl className="kv">
              <dt>Billets</dt>
              <dd>{formatCents(subtotal)}</dd>
              <dt>Frais de service</dt>
              <dd>
                {formatCents(fee)}
                {rules.serviceFeeBasisPoints > 0 || rules.serviceFeeFixedCents > 0 ? (
                  <span className="muted">
                    {' '}
                    ({[rules.serviceFeeFixedCents > 0 ? formatCents(rules.serviceFeeFixedCents) : null, rules.serviceFeeBasisPoints > 0 ? formatBasisPoints(rules.serviceFeeBasisPoints) : null]
                      .filter(Boolean)
                      .join(' + ')}
                    )
                  </span>
                ) : null}
              </dd>
              <dt>Total</dt>
              <dd>
                <strong>{formatCents(subtotal + fee)}</strong>
              </dd>
            </dl>
            <p className="muted">Le montant définitif est confirmé à l’étape suivante.</p>
          </section>

          <section className="stack" aria-labelledby="titre-conditions">
            <h2 id="titre-conditions">Conditions</h2>
            {rules.selfCancellationEnabled ? (
              <p>
                Annulation possible depuis votre compte{' '}
                {rules.cancellationDeadlineHours === 0 ? 'jusqu’au début de l’événement' : `jusqu’à ${rules.cancellationDeadlineHours} h avant le début (soit le ${formatDateTime(cancelDeadline, event.timezone)})`}
                , tant qu’aucun billet n’a été scanné. Remboursement : {rules.refundPercent} % du prix des billets.
              </p>
            ) : (
              <p>Pas d’annulation en ligne pour cet événement{event.contactEmail ? ` ; contact : ${event.contactEmail}` : ''}.</p>
            )}
          </section>

          {status === 'authenticated' && user ? (
            user.emailVerified ? (
              <button type="submit" className="btn btn--block" disabled={createOrder.isPending || totalQty === 0} aria-disabled={createOrder.isPending || totalQty === 0}>
                {createOrder.isPending ? 'Réservation en cours…' : totalQty === 0 ? 'Choisissez vos places' : `Réserver ${totalQty} place${totalQty > 1 ? 's' : ''}`}
              </button>
            ) : (
              <div className="alert alert--warning stack">
                <p>Confirmez votre adresse email pour réserver (lien reçu par mail).</p>
                <button type="button" className="btn btn--secondary" disabled={resend.isPending || resend.isSuccess} onClick={() => { resend.mutate(user.email); }}>
                  {resend.isSuccess ? 'Email renvoyé' : 'Renvoyer l’email de confirmation'}
                </button>
              </div>
            )
          ) : (
            <Link className="btn btn--block" to={loginPathWithNext(apiPath`/events/${event.id}`)}>
              Se connecter pour réserver
            </Link>
          )}
          {createOrder.error ? (
            <div className="alert alert--error" role="alert">
              {soldOutName ? `Plus assez de places « ${soldOutName} ». Les disponibilités ont été mises à jour.` : errorMessage(createOrder.error)}
            </div>
          ) : null}
        </>
      ) : (
        <p className="alert alert--info">
          {now < Date.parse(event.salesStartAt) ? `Ouverture de la billetterie le ${formatDateTime(event.salesStartAt, event.timezone)}.` : 'La billetterie de cet événement est fermée.'}
        </p>
      )}
    </form>
  );
}
