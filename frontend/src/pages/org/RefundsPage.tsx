import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { apiPath } from '../../api/client';
import { isApiError } from '../../api/errors';
import { useMarkRefundDone, useRefunds } from '../../api/hooks/org';
import { REFUND_STATUSES, type RefundAdmin, type RefundStatus } from '../../api/types';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { ErrorAlert } from '../../components/ErrorAlert';
import { PageLoader } from '../../components/PageLoader';
import { retryAtFrom } from '../../lib/retryAfter';
import { RefundMarkFeedback } from './RefundMarkFeedback';
import { REFUND_REASON_LABELS, REFUND_STATUS_LABELS } from '../../lib/labels';
import { lookup } from '../../lib/lookup';
import { formatCents } from '../../lib/money';
import { formatDateTime, userTimeZone } from '../../lib/time';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TO_PROCESS = new Set<RefundStatus>(['MANUAL_REQUIRED', 'FAILED']);

/** Suivi des remboursements (contrat v1.10) : les virements se remboursent à la main puis se marquent effectués. */
export function RefundsPage() {
  const { orgId = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const rawStatus = params.get('status');
  const status = REFUND_STATUSES.find((s) => s === rawStatus);
  const rawEvent = params.get('eventId');
  const eventId = rawEvent && UUID.test(rawEvent) ? rawEvent : undefined;
  const [page, setPage] = useState(1);
  const { data, error, isPending } = useRefunds(orgId, { status, eventId, page });
  const mark = useMarkRefundDone(orgId);
  const [target, setTarget] = useState<RefundAdmin | null>(null);
  const [note, setNote] = useState('');
  // Dernière tentative (pour « Réessayer » après un 503 du prestataire).
  const [attempt, setAttempt] = useState<{ refundId: string; note: string; method: RefundAdmin['method'] } | null>(null);
  const [retryAt, setRetryAt] = useState<number | null>(null);
  const send = (a: { refundId: string; note: string; method: RefundAdmin['method'] }) => {
    setAttempt(a);
    setRetryAt(null);
    mark.mutate(
      { refundId: a.refundId, note: a.note },
      {
        onError: (e) => {
          if (isApiError(e) && e.code === 'PAYMENT_PROVIDER_UNAVAILABLE') setRetryAt(retryAtFrom(e.retryAfter));
        },
        onSettled: close,
      },
    );
  };
  const tz = userTimeZone();

  const setFilter = (key: 'status' | 'eventId', value: string | undefined) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
    setPage(1);
  };
  const close = () => {
    setTarget(null);
    setNote('');
  };

  return (
    <section className="page">
      <h1>Remboursements</h1>
      <p className="muted">
        Les remboursements de commandes payées par virement doivent être faits à la main (virement retour), puis marqués comme effectués ici.
      </p>
      <div className="row">
        <div className="field m-0">
          <label htmlFor="r-status">Statut</label>
          <select id="r-status" value={status ?? ''} onChange={(e) => setFilter('status', e.target.value || undefined)}>
            <option value="">Tous</option>
            {REFUND_STATUSES.map((s) => (
              <option key={s} value={s}>
                {REFUND_STATUS_LABELS[s]}
              </option>
            ))}
          </select>
        </div>
        {eventId ? (
          <button type="button" className="btn btn--secondary btn--small" onClick={() => setFilter('eventId', undefined)}>
            Tous les événements
          </button>
        ) : null}
      </div>
      {isPending ? <PageLoader /> : null}
      <ErrorAlert error={error} />
      {data?.items.length === 0 ? <p>Aucun remboursement.</p> : null}
      <ul className="list-reset stack">
        {data?.items.map((r) => (
          <li key={r.id} className={`card stack${TO_PROCESS.has(r.status) ? ' card--attention' : ''}`}>
            <div className="row row--between">
              <strong>{formatCents(r.amountCents)}</strong>
              <span className={`badge badge--${r.status === 'SUCCEEDED' ? 'available' : TO_PROCESS.has(r.status) ? 'sold_out' : 'low'}`}>
                {lookup(REFUND_STATUS_LABELS, r.status) ?? 'Statut inconnu'}
              </span>
            </div>
            <p className="m-0">
              {r.buyerEmail ?? 'Acheteur inconnu'} — {r.eventId ? <Link to={apiPath`/org/${orgId}/events/${r.eventId}`}>{r.eventTitle ?? 'Événement'}</Link> : 'sans événement'}
            </p>
            <p className="muted m-0">
              {lookup(REFUND_REASON_LABELS, r.reason) ?? 'Motif inconnu'} · {r.method === 'TRANSFER' ? 'payé par virement' : 'payé par carte'} · {formatDateTime(r.createdAt, tz)}
            </p>
            {r.note ? <p className="m-0 pre-line">Note : {r.note}</p> : null}
            {TO_PROCESS.has(r.status) ? (
              <button type="button" className="btn btn--small" onClick={() => setTarget(r)}>
                Marquer comme effectué
              </button>
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
      <RefundMarkFeedback error={mark.error} method={attempt?.method ?? null} retryAt={retryAt} busy={mark.isPending} onRetry={() => attempt && send(attempt)} />
      <ConfirmDialog
        open={target !== null}
        title="Confirmer le remboursement effectué ?"
        confirmLabel="Marquer comme effectué"
        busy={mark.isPending}
        confirmDisabled={note.trim().length < 1 || note.length > 500}
        onCancel={close}
        onConfirm={() => {
          if (target) send({ refundId: target.id, note: note.trim(), method: target.method });
        }}
      >
        <p>
          Confirmez que vous avez bien remboursé <strong>{target ? formatCents(target.amountCents) : ''}</strong> à <strong>{target?.buyerEmail ?? 'l’acheteur'}</strong>. Cette déclaration est
          tracée dans le journal.
        </p>
        <div className="field">
          <label htmlFor="refund-note">Note (ex. « virement retour effectué le 12/11 »)</label>
          <textarea id="refund-note" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
      </ConfirmDialog>
    </section>
  );
}
