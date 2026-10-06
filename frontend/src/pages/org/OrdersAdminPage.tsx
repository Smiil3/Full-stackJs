import { useDeferredValue, useState, type SubmitEvent } from 'react';
import { Link, useParams } from 'react-router';
import { apiPath } from '../../api/client';
import { errorMessage, isApiError } from '../../api/errors';
import { useConfirmTransfer, useEventOrders, useOrgEvent } from '../../api/hooks/org';
import { ORDER_STATUSES, type OrderAdmin, type OrderStatus } from '../../api/types';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { ErrorAlert } from '../../components/ErrorAlert';
import { Field } from '../../components/Field';
import { OrderStatusBadge } from '../../components/OrderStatusBadge';
import { PageLoader } from '../../components/PageLoader';
import { ORDER_STATUS_LABELS } from '../../lib/labels';
import { eurosToCents, formatCents } from '../../lib/money';
import { formatDateTime } from '../../lib/time';

function ConfirmTransfer({ orgId, eventId, order }: { orgId: string; eventId: string; order: OrderAdmin }) {
  const confirm = useConfirmTransfer(orgId, eventId);
  const [amount, setAmount] = useState('');
  const [local, setLocal] = useState<string | undefined>();
  const [toConfirm, setToConfirm] = useState<number | null>(null);
  const submit = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    const r = eurosToCents(amount, 100_000_000);
    if (!r.ok || r.value <= 0) {
      setLocal('Saisissez le montant reçu (supérieur à 0).');
      return;
    }
    setLocal(undefined);
    setToConfirm(r.value); // récapitulatif avant validation définitive
  };
  const validate = () => {
    if (toConfirm === null || confirm.isPending) return;
    confirm.mutate({ orderId: order.id, receivedAmountCents: toConfirm }, { onSettled: () => setToConfirm(null) });
  };
  const mismatch = isApiError(confirm.error) && confirm.error.code === 'AMOUNT_MISMATCH';
  return (
    <form className="stack" onSubmit={submit} noValidate>
      <Field
        label="Montant reçu sur le compte (€)"
        inputMode="decimal"
        hint={`Montant dû : ${formatCents(order.totalCents)}`}
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        error={local}
      />
      <button type="submit" className="btn btn--small" disabled={confirm.isPending}>
        {confirm.isPending ? 'Validation…' : 'Valider le virement'}
      </button>
      {confirm.error ? (
        <p className="alert alert--error" role="alert">
          {mismatch ? `Le montant saisi ne correspond pas au montant dû (${formatCents(order.totalCents)}). Vérifiez le relevé bancaire.` : errorMessage(confirm.error)}
        </p>
      ) : null}
      <ConfirmDialog
        open={toConfirm !== null}
        title="Valider ce virement ?"
        confirmLabel="Valider le virement"
        busy={confirm.isPending}
        onCancel={() => setToConfirm(null)}
        onConfirm={validate}
      >
        <dl className="kv">
          <dt>Acheteur</dt>
          <dd>{order.buyer.email}</dd>
          <dt>Référence</dt>
          <dd className="mono">{order.transferInstructions?.reference ?? '—'}</dd>
          <dt>Montant dû</dt>
          <dd>{formatCents(order.totalCents)}</dd>
          <dt>Montant reçu saisi</dt>
          <dd>
            <strong>{toConfirm !== null ? formatCents(toConfirm) : '—'}</strong>
          </dd>
        </dl>
        <p>Les billets seront émis et envoyés à l’acheteur. Vérifiez la référence sur le relevé bancaire.</p>
      </ConfirmDialog>
    </form>
  );
}

export function OrdersAdminPage() {
  const { orgId = '', eventId = '' } = useParams();
  const event = useOrgEvent(orgId, eventId);
  const [status, setStatus] = useState<OrderStatus | ''>('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const deferredQ = useDeferredValue(q.trim().slice(0, 100));
  const { data, error, isPending } = useEventOrders(orgId, eventId, { status: status || undefined, q: deferredQ || undefined, page });
  const tz = event.data?.timezone ?? 'Europe/Paris';
  return (
    <section className="page">
      <p>
        <Link to={apiPath`/org/${orgId}/events/${eventId}`}>← {event.data?.title ?? 'Événement'}</Link>
      </p>
      <h1>Commandes</h1>
      <div className="grid-2">
        <div className="field">
          <label htmlFor="f-status">Statut</label>
          <select
            id="f-status"
            value={status}
            onChange={(e) => {
              setStatus(e.target.value as OrderStatus | '');
              setPage(1);
            }}
          >
            <option value="">Tous</option>
            {ORDER_STATUSES.map((s) => (
              <option key={s} value={s}>
                {ORDER_STATUS_LABELS[s]}
              </option>
            ))}
          </select>
        </div>
        <Field
          label="Rechercher par email"
          type="search"
          maxLength={100}
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setPage(1);
          }}
        />
      </div>
      {isPending ? <PageLoader /> : null}
      <ErrorAlert error={error} />
      {data?.items.length === 0 ? <p>Aucune commande.</p> : null}
      <ul className="list-reset stack">
        {data?.items.map((o) => (
          <li key={o.id} className="card stack">
            <div className="row row--between">
              <span>
                <strong>{o.buyer.displayName}</strong> <span className="muted">{o.buyer.email}</span>
              </span>
              <OrderStatusBadge status={o.status} />
            </div>
            <p className="m-0">
              {o.items.map((i) => `${i.quantity} × ${i.name}`).join(', ')} — <strong>{formatCents(o.totalCents)}</strong>
              {o.paymentMethod === 'TRANSFER' ? ' (virement)' : ' (carte)'}
            </p>
            <p className="muted m-0">Commandée le {formatDateTime(o.createdAt, tz)}</p>
            {o.status === 'AWAITING_TRANSFER' && o.transferInstructions ? (
              <>
                <p className="m-0">
                  Référence : <strong className="mono">{o.transferInstructions.reference}</strong> · à recevoir avant le {formatDateTime(o.transferInstructions.deadline, tz)} · compte{' '}
                  <span className="mono">{o.transferInstructions.iban}</span>
                </p>
                <ConfirmTransfer orgId={orgId} eventId={eventId} order={o} />
              </>
            ) : null}
          </li>
        ))}
      </ul>
      {data && data.total > data.pageSize ? (
        <nav className="row" aria-label="Pagination">
          <button type="button" className="btn btn--secondary" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            Précédent
          </button>
          <span>
            Page {page} / {Math.ceil(data.total / data.pageSize)}
          </span>
          <button type="button" className="btn btn--secondary" disabled={page * data.pageSize >= data.total} onClick={() => setPage((p) => p + 1)}>
            Suivant
          </button>
        </nav>
      ) : null}
    </section>
  );
}
