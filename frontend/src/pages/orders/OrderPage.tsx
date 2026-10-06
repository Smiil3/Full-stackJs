import { useState } from 'react';
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
import { useNow } from '../../lib/hooks/useNow';
import { formatCents } from '../../lib/money';
import { currentPspEnv, resolvePspRedirect } from '../../lib/pspRedirect';
import { OrderSummary } from './OrderSummary';
import { canCancel, refundPreviewCents } from './orderRules';
import { TransferInstructions } from './TransferInstructions';

/** Durée max d'attente de la confirmation du paiement après retour du PSP (contrat §4). */
const PAYMENT_POLL_MS = 60_000;

export function OrderPage() {
  const { orderId } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const payment = params.get('payment');
  const [pollUntil] = useState(() => (payment === 'success' ? Date.now() + PAYMENT_POLL_MS : 0));
  const now = useNow(1000);
  const polling = payment === 'success' && now < pollUntil;
  // La redirection du PSP ne prouve rien : seul le statut renvoyé par l'API (webhook traité) fait foi.
  const { data: order, error, isPending, refetch } = useOrder(orderId, { pollUntilPaid: polling });
  const checkout = useCheckout();
  const cancel = useCancelOrder();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [redirectError, setRedirectError] = useState(false);

  if (isPending) return <PageLoader />;
  if (!order) return <ErrorAlert error={error} />;

  const pay = () => {
    if (checkout.isPending) return;
    setRedirectError(false);
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

  const paidStatusKnown = order.status !== 'PENDING_PAYMENT';

  return (
    <section className="page">
      <p>
        <Link to="/me/orders">← Mes commandes</Link>
      </p>
      <h1>Commande</h1>
      <div className="card stack">
        <h2 className="card__title">
          <Link to={apiPath`/events/${order.eventId}`}>{order.eventTitle}</Link>
        </h2>
        <EventTime iso={order.eventStartsAt} timezone={order.eventTimezone} />
        <p className="row">
          <OrderStatusBadge status={order.status} />
          <span className="muted">{order.paymentMethod === 'CARD' ? 'Carte bancaire' : 'Virement'}</span>
        </p>
      </div>

      <div aria-live="polite">
        {payment === 'success' && !paidStatusKnown ? (
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
            Le paiement n’a pas abouti. Aucun montant n’a été débité ; vous pouvez réessayer tant que la réservation est active.
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

      <OrderSummary order={order} />

      {order.status === 'PENDING_PAYMENT' && order.expiresAt ? (
        <div className="stack">
          <Countdown until={order.expiresAt} label="Places réservées encore" onExpire={() => void refetch()} />
          {!polling ? (
            <button type="button" className="btn btn--block" onClick={pay} disabled={checkout.isPending || Date.parse(order.expiresAt) <= now}>
              {checkout.isPending ? 'Redirection vers le paiement…' : `Payer ${formatCents(order.totalCents)} par carte`}
            </button>
          ) : null}
          <ErrorAlert error={checkout.error} />
          {redirectError ? (
            <p className="alert alert--error" role="alert">
              Adresse de paiement inattendue : par sécurité, la redirection a été bloquée. Réessayez ou contactez l’organisateur.
            </p>
          ) : null}
        </div>
      ) : null}

      {order.status === 'AWAITING_TRANSFER' && order.transferInstructions ? <TransferInstructions order={order} t={order.transferInstructions} /> : null}

      {canCancel(order, now) ? (
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
            Vos billets seront annulés définitivement. Montant remboursé : <strong>{formatCents(refundPreviewCents(order))}</strong> ({order.refundPercent} % du prix des billets
            {order.serviceFeeCents > 0 ? ', hors frais de service sauf conditions contraires du collectif' : ''}). Le montant définitif s’affichera après confirmation.
          </p>
        ) : (
          <p>Les places réservées seront libérées. Aucun paiement n’a été encaissé.</p>
        )}
      </ConfirmDialog>
    </section>
  );
}
