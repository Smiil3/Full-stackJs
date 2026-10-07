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
import { Icon } from '../../components/Icon';
import { QuantityStepper } from '../../components/QuantityStepper';
import { estimateServiceFeeCents, formatBasisPoints, formatCents, formatPrice } from '../../lib/money';
import { useNow } from '../../lib/hooks/useNow';
import { formatDate, formatDateTime } from '../../lib/time';
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

  // Panier DÉRIVÉ des types présents et non épuisés (une quantité restée sur un type devenu
  // complet ou retiré n'est jamais envoyée), quantité bornée par le plafond par commande.
  const items = useMemo(
    () =>
      event.ticketTypes
        .filter((t) => t.availability !== 'SOLD_OUT')
        .map((t) => ({ ticketTypeId: t.id, quantity: Math.min(quantities[t.id] ?? 0, rules.maxPerOrder), price: t.currentPriceCents }))
        .filter((i) => i.quantity > 0),
    [event.ticketTypes, quantities, rules.maxPerOrder],
  );
  const totalQty = items.reduce((s, i) => s + i.quantity, 0);
  const subtotal = items.reduce((s, i) => s + i.price * i.quantity, 0);
  const fee = totalQty > 0 ? estimateServiceFeeCents(subtotal, rules.serviceFeeFixedCents, rules.serviceFeeBasisPoints) : 0;
  const effectiveMethod: PaymentMethod = rules.transferEnabled ? method : 'CARD';


  const soldOutName = (() => {
    const e = createOrder.error;
    if (!isApiError(e) || e.code !== 'SOLD_OUT') return null;
    return event.ticketTypes.find((t) => t.id === e.details?.ticketTypeId)?.name ?? null;
  })();

  const submit = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (createOrder.isPending || items.length === 0) return;
    createOrder.mutate(
      { eventId: event.id, paymentMethod: effectiveMethod, items: items.map(({ ticketTypeId, quantity }) => ({ ticketTypeId, quantity })) },
      {
        onSuccess: (order) => {
          void navigate(order.status === 'PAID' ? '/me/tickets' : apiPath`/orders/${order.id}`);
        },
        onError: (err) => {
          if (isApiError(err) && err.code === 'SOLD_OUT') {
            const soldOut = err.details?.ticketTypeId;
            if (typeof soldOut === 'string') setQuantities((q) => ({ ...q, [soldOut]: 0 }));
          }
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
          return (
            <li key={t.id} className="ticket-type" data-selected={current > 0 ? 'true' : undefined}>
              <div className="ticket-type__head">
                <h3>{t.name}</h3>
                <AvailabilityBadge value={t.availability} waitlist={rules.waitlistEnabled} />
              </div>
              {t.description ? <p className="pre-line muted">{t.description}</p> : null}
              {t.isEarly && t.earlyUntil ? (
                <p className="ticket-type__early">
                  <Icon name="tag" size="sm" /> Tarif early jusqu’au {formatDateTime(t.earlyUntil, event.timezone)}
                </p>
              ) : null}
              <div className="ticket-type__foot">
                <p>
                  <span className="ticket-type__price">{formatPrice(t.currentPriceCents)}</span>
                  {t.isEarly ? (
                    <>
                      {' '}
                      <span className="visually-hidden">au lieu de</span>
                      <span className="price-was price-old">{formatCents(t.regularPriceCents)}</span>
                    </>
                  ) : null}
                </p>
                {t.availability !== 'SOLD_OUT' && event.salesOpen ? (
                  <QuantityStepper
                    name={t.name}
                    value={current}
                    max={Math.min(max, rules.maxPerOrder)}
                    onChange={(n) => {
                      setQuantities((q) => ({ ...q, [t.id]: n }));
                    }}
                  />
                ) : null}
              </div>
              {t.availability === 'SOLD_OUT' ? (
                rules.waitlistEnabled ? (
                  <WaitlistJoin eventId={event.id} ticketType={t} maxPerOrder={rules.maxPerOrder} />
                ) : (
                  <p className="muted">Toutes les places sont parties.</p>
                )
              ) : null}
            </li>
          );
        })}
      </ul>
      <p className="muted">Maximum {rules.maxPerOrder} place{rules.maxPerOrder > 1 ? 's' : ''} par commande, {rules.maxPerUser} par personne pour cet événement.</p>

      {event.salesOpen ? (
        <>
          <fieldset className="stack stack--sm choice-group">
            <legend>Moyen de paiement</legend>
            <label className="choice">
              <input type="radio" name={methodName} value="CARD" checked={effectiveMethod === 'CARD'} onChange={() => setMethod('CARD')} />
              <span className="choice__text">
                Carte bancaire
                <span className="choice__hint">Billets reçus immédiatement. Places gardées {rules.cardHoldMinutes} min le temps du paiement.</span>
              </span>
            </label>
            {rules.transferEnabled ? (
              <label className="choice">
                <input type="radio" name={methodName} value="TRANSFER" checked={effectiveMethod === 'TRANSFER'} onChange={() => setMethod('TRANSFER')} />
                <span className="choice__text">
                  Virement bancaire
                  <span className="choice__hint">Vos places sont gardées {rules.transferHoldHours} h, le temps que le virement arrive.</span>
                </span>
              </label>
            ) : null}
          </fieldset>

          <section className="card stack" data-theme="light" aria-labelledby="titre-recap">
            <h2 id="titre-recap">Récapitulatif</h2>
            <div className="summary">
              {items.map((i) => (
                <p key={i.ticketTypeId} className="summary__line">
                  <span>
                    {i.quantity} × {event.ticketTypes.find((t) => t.id === i.ticketTypeId)?.name}
                  </span>
                  <span>{formatCents(i.price * i.quantity)}</span>
                </p>
              ))}
              <p className="summary__line">
                <span>
                  Frais de service
                  {rules.serviceFeeBasisPoints > 0 || rules.serviceFeeFixedCents > 0 ? (
                    <span className="muted">
                      {' '}
                      ({[rules.serviceFeeFixedCents > 0 ? formatCents(rules.serviceFeeFixedCents) : null, rules.serviceFeeBasisPoints > 0 ? formatBasisPoints(rules.serviceFeeBasisPoints) : null]
                        .filter(Boolean)
                        .join(' + ')}
                      )
                    </span>
                  ) : null}
                </span>
                <span>{formatCents(fee)}</span>
              </p>
              <p className="summary__total">
                <span>Total</span>
                <span className="summary__total-amount" aria-live="polite">
                  {formatCents(subtotal + fee)}
                </span>
              </p>
            </div>
            <p className="muted">
              {rules.selfCancellationEnabled
                ? `Annulation possible depuis votre compte ${rules.cancellationDeadlineHours === 0 ? 'jusqu’au début de l’événement' : `jusqu’au ${formatDate(cancelDeadline, event.timezone)} (${rules.cancellationDeadlineHours} h avant le début, soit le ${formatDateTime(cancelDeadline, event.timezone)})`}, tant qu’aucun billet n’a été scanné ; remboursement de ${rules.refundPercent} % du prix des billets.`
                : `Pas d’annulation en ligne pour cet événement${event.contactEmail ? ` ; contact : ${event.contactEmail}` : ''}.`}{' '}
              Le montant définitif est confirmé à l’étape suivante.
            </p>
          </section>

          {status === 'authenticated' && user ? (
            user.emailVerified ? (
              <div className="action-bar">
                <button type="submit" className="btn btn--block" disabled={createOrder.isPending || totalQty === 0}>
                  {createOrder.isPending
                    ? 'Réservation en cours…'
                    : totalQty === 0
                      ? 'Choisissez au moins une place'
                      : `Réserver ${totalQty} place${totalQty > 1 ? 's' : ''} · ${formatCents(subtotal + fee)}${effectiveMethod === 'CARD' ? ' par carte' : ' par virement'}`}
                </button>
              </div>
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
