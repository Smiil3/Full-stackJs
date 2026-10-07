import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { apiPath } from '../../api/client';
import { errorMessage, isApiError } from '../../api/errors';
import { useCancelOrder, useCheckout, useOrder } from '../../api/hooks/orders';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { Countdown } from '../../components/Countdown';
import { ErrorAlert } from '../../components/ErrorAlert';
import { EventTime } from '../../components/EventTime';
import { OrderStatusBadge } from '../../components/OrderStatusBadge';
import { PageLoader } from '../../components/PageLoader';
import { Icon } from '../../components/Icon';
import { RetryLater } from '../../components/RetryLater';
import { retryAtFrom } from '../../lib/retryAfter';
import { useNow } from '../../lib/hooks/useNow';
import { formatCents } from '../../lib/money';
import { currentPspEnv, resolvePspRedirect } from '../../lib/pspRedirect';
import { formatTime, userTimeZone } from '../../lib/time';
import { OrderSummary } from './OrderSummary';
import { canCancel } from './orderRules';
import { TransferInstructions } from './TransferInstructions';

/** Durée max d'attente de la confirmation du paiement après retour du PSP (contrat §4). */
const PAYMENT_POLL_MS = 60_000;

export function OrderPage() {
  const { orderId } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const payment = params.get('payment');
  const now = useNow(1000);
  const [pollTimedOutFor, setPollTimedOutFor] = useState<string | null>(null);
  const pollAllowed = pollTimedOutFor !== orderId;
  // La redirection du PSP ne prouve rien : seul le statut renvoyé par l'API (webhook traité) fait foi.
  const { data: order, error, isPending, refetch } = useOrder(orderId, { poll: pollAllowed, paymentReturned: payment === 'success' });
  // Paiement en cours (session ouverte selon le SERVEUR, v1.16 — survit au rechargement) ou retour « success »
  // du PSP : jamais de nouveau « Payer », ni d'annulation, tant que le serveur n'a pas tranché.
  const paymentInProgress = order?.status === 'PENDING_PAYMENT' && order.paymentInProgress;
  const awaitingConfirmation = order?.status === 'PENDING_PAYMENT' && (paymentInProgress || payment === 'success');
  useEffect(() => {
    if (!awaitingConfirmation || !orderId) return;
    const timer = setTimeout(() => {
      setPollTimedOutFor(orderId);
    }, PAYMENT_POLL_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [orderId, awaitingConfirmation]);
  const polling = awaitingConfirmation && pollAllowed;
  const checkout = useCheckout();
  const cancel = useCancelOrder();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [redirectError, setRedirectError] = useState(false);
  const [providerRetryAt, setProviderRetryAt] = useState<number | null>(null);

  if (isPending) return <PageLoader />;
  if (!order) return <ErrorAlert error={error} />;

  const pay = () => {
    if (checkout.isPending) return;
    setRedirectError(false);
    setProviderRetryAt(null);
    checkout.mutate(order.id, {
      onSuccess: ({ redirectUrl }) => {
        const target = resolvePspRedirect(redirectUrl, currentPspEnv());
        if (!target) {
          setRedirectError(true);
          return;
        }
        if (target.kind === 'internal') void navigate(target.path);
        else window.location.assign(target.url);
      },
      onError: (e) => {
        if (isApiError(e) && (e.code === 'ORDER_EXPIRED' || e.code === 'INVALID_STATE')) void refetch();
        // Prestataire injoignable : rien n'est perdu, nouvel essai possible après Retry-After.
        if (isApiError(e) && e.code === 'PAYMENT_PROVIDER_UNAVAILABLE') setProviderRetryAt(retryAtFrom(e.retryAfter));
      },
    });
  };

  const doCancel = () => {
    cancel.mutate(order.id, {
      onSettled: () => {
        setConfirmOpen(false);
      },
    });
  };

  const transfer = order.status === 'AWAITING_TRANSFER' && order.transferInstructions !== null;
  return (
    <section className="page">
      <p>
        <Link to="/me/orders">← Mes commandes</Link>
      </p>
      {transfer ? (
        <div className="stack stack--sm">
          <p className="row ok-line">
            <Icon name="check-circle" /> Réservation enregistrée
          </p>
          <h1>Il ne reste plus qu’à faire le virement</h1>
        </div>
      ) : (
        <h1>Commande</h1>
      )}
      <div className="card stack">
        <h2 className="card__title">
          <Link to={apiPath`/events/${order.eventId}`}>{order.eventTitle}</Link>
        </h2>
        <EventTime iso={order.eventStartsAt} timezone={order.eventTimezone} />
        <p className="row">
          <OrderStatusBadge status={order.status} />
          <span className="muted">{order.paymentMethod === 'CARD' ? 'Carte bancaire' : 'Virement'}</span>
        </p>
        <p className="muted">
          {order.items.map((i) => `${i.quantity} × ${i.name}`).join(', ')} · <a href="#details-commande">Détails</a>
        </p>
      </div>
      {transfer && order.transferInstructions ? <TransferInstructions order={order} t={order.transferInstructions} /> : null}

      <div aria-live="polite">
        {awaitingConfirmation ? (
          polling ? (
            <p className="alert alert--info" role="status">
              Paiement en cours de confirmation… Cette page se met à jour automatiquement.
            </p>
          ) : (
            <div className="alert alert--warning stack">
              <p>La confirmation de votre paiement prend plus de temps que prévu. Vous recevrez vos billets par email dès sa réception ; vous pouvez aussi actualiser cette page.</p>
              <button type="button" className="btn btn--secondary" onClick={() => void refetch()}>
                Actualiser
              </button>
            </div>
          )
        ) : null}
        {payment === 'failed' && order.status === 'PENDING_PAYMENT' ? (
          <p className="alert alert--error" role="alert">
            <Icon name="info" />
            <span>
              Le paiement n’est pas passé. Aucun montant n’a été débité.
              {order.expiresAt ? ` Vos places restent gardées jusqu’à ${formatTime(order.expiresAt, order.eventTimezone)}.` : ''} Vous pouvez réessayer.
            </span>
          </p>
        ) : null}
        {order.status === 'PAID' ? (
          <p className="alert alert--success" role="status">
            Paiement confirmé ! Vos billets sont disponibles dans <Link to="/me/tickets">Mes billets</Link> et vous ont été envoyés par email.
          </p>
        ) : null}
        {order.status === 'EXPIRED' ? (
          <p className="alert alert--error" role="alert">
            Le délai de réservation est dépassé : les places ont été libérées. <Link to={apiPath`/events/${order.eventId}`}>Refaire une réservation</Link>
          </p>
        ) : null}
        {order.status === 'CANCELLED' ? <p className="alert alert--info">Commande annulée.</p> : null}
        {order.status === 'REFUNDED' ? (
          <p className="alert alert--info">Commande annulée et remboursée{order.refundAmountCents !== null ? ` : ${formatCents(order.refundAmountCents)}` : ''}.</p>
        ) : null}
      </div>

      <div id="details-commande">
        <OrderSummary order={order} />
      </div>

      {order.status === 'PENDING_PAYMENT' && order.expiresAt ? (
        <div className="stack">
          <Countdown until={order.expiresAt} label="Places réservées encore" onExpire={() => void refetch()} />
          {paymentInProgress ? (
            // Le serveur renvoie la MÊME session de paiement : aucun risque de double débit.
            <button type="button" className="btn btn--block btn--secondary" onClick={pay} disabled={checkout.isPending}>
              {checkout.isPending ? 'Redirection vers le paiement…' : 'Reprendre le paiement'}
            </button>
          ) : !awaitingConfirmation ? (
            <button type="button" className="btn btn--block" onClick={pay} disabled={checkout.isPending}>
              {checkout.isPending ? 'Redirection vers le paiement…' : `Payer ${formatCents(order.totalCents)} par carte`}
            </button>
          ) : null}
          {providerRetryAt !== null && isApiError(checkout.error) && checkout.error.code === 'PAYMENT_PROVIDER_UNAVAILABLE' ? (
            <RetryLater retryAt={providerRetryAt} onRetry={pay} busy={checkout.isPending}>
              Le paiement est momentanément indisponible. Vos places restent réservées jusqu’à <strong>{formatTime(order.expiresAt, userTimeZone())}</strong>. Réessayez dans un instant.
            </RetryLater>
          ) : (
            <ErrorAlert error={checkout.error} />
          )}
          {redirectError ? (
            <p className="alert alert--error" role="alert">
              Adresse de paiement inattendue : par sécurité, la redirection a été bloquée. Réessayez ou contactez l’organisateur.
            </p>
          ) : null}
        </div>
      ) : null}


      {canCancel(order, now) && !paymentInProgress && !polling ? (
        <div className="stack">
          {order.status === 'PAID' && order.cancellableUntil ? (
            <p className="muted">
              Annulation possible jusqu’au <EventTime iso={order.cancellableUntil} timezone={order.eventTimezone} />
            </p>
          ) : null}
          <button type="button" className="btn btn--secondary" onClick={() => setConfirmOpen(true)}>
            Annuler la commande
          </button>
        </div>
      ) : null}
      {cancel.error ? (
        <p className="alert alert--error" role="alert">
          {errorMessage(cancel.error)}
        </p>
      ) : null}

      <ConfirmDialog
        open={confirmOpen}
        title="Annuler cette commande ?"
        confirmLabel="Oui, annuler la commande"
        cancelLabel="Non, la garder"
        danger
        busy={cancel.isPending}
        onConfirm={doCancel}
        onCancel={() => setConfirmOpen(false)}
      >
        {order.status === 'PAID' ? (
          <p>
            Vos billets seront annulés définitivement. Montant remboursé : <strong>{formatCents(order.refundPreviewCents ?? 0)}</strong>.
          </p>
        ) : (
          <p>Les places réservées seront libérées. Aucun paiement n’a été encaissé.</p>
        )}
      </ConfirmDialog>
    </section>
  );
}
