import { useState } from 'react';
import { isApiError } from '../../api/errors';
import { useAdminMarkRefundDone, useAdminRefunds, useRetryStuckOrder, useStuckOrders } from '../../api/hooks/admin';
import type { RefundAdmin, StuckOrder } from '../../api/types';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { ErrorAlert } from '../../components/ErrorAlert';
import { PageLoader } from '../../components/PageLoader';
import { ORDER_STATUS_LABELS, REFUND_REASON_LABELS, REFUND_STATUS_LABELS } from '../../lib/labels';
import { lookup } from '../../lib/lookup';
import { formatCents } from '../../lib/money';
import { retryAtFrom } from '../../lib/retryAfter';
import { formatDateTime, userTimeZone } from '../../lib/time';
import { RefundMarkFeedback } from '../org/RefundMarkFeedback';
import { AdminNav } from './AdminNav';

const TO_PROCESS = new Set(['MANUAL_REQUIRED', 'FAILED']);

/**
 * Anomalies de la plateforme (contrat v1.17 §8, audit B2 / B3) : remboursements de paiements sans
 * commande rattachée, et commandes écartées de l'expiration automatique (bouton « Relancer »).
 */
export function AdminAnomaliesPage() {
  return (
    <section className="page">
      <h1>Administration</h1>
      <AdminNav />
      <OrphanRefunds />
      <StuckOrders />
    </section>
  );
}

function OrphanRefunds() {
  const [page, setPage] = useState(1);
  const { data, error, isPending, refetch } = useAdminRefunds(page);
  const mark = useAdminMarkRefundDone();
  const [target, setTarget] = useState<RefundAdmin | null>(null);
  const [note, setNote] = useState('');
  const [attempt, setAttempt] = useState<{ refundId: string; note: string; method: RefundAdmin['method'] } | null>(null);
  const [retryAt, setRetryAt] = useState<number | null>(null);
  const tz = userTimeZone();
  const close = () => {
    setTarget(null);
    setNote('');
  };
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
  return (
    <section className="stack" aria-labelledby="titre-orphelins">
      <h2 id="titre-orphelins">Remboursements sans commande</h2>
      <p className="muted">Paiements reçus sans commande rattachée (paiement inattendu, en double…) : à rembourser puis à marquer comme effectués.</p>
      {isPending ? <PageLoader shape="text" /> : null}
      <ErrorAlert error={error} onRetry={() => void refetch()} />
      {data && data.items.length === 0 ? <p className="muted">Aucun remboursement sans commande.</p> : null}
      <ul className="list-reset stack">
        {data?.items.map((r) => (
          <li key={r.id} className={`card stack${TO_PROCESS.has(r.status) ? ' card--attention' : ''}`}>
            <p className="row row--between">
              <strong>{formatCents(r.amountCents)}</strong>
              <span className="badge badge--info">{lookup(REFUND_STATUS_LABELS, r.status) ?? 'Statut inconnu'}</span>
            </p>
            <p>
              {lookup(REFUND_REASON_LABELS, r.reason) ?? 'Motif inconnu'} · {r.method === 'CARD' ? 'carte' : 'virement'} · {r.buyerEmail ?? 'payeur inconnu'}
            </p>
            <p className="muted">Reçu le {formatDateTime(r.createdAt, tz)}</p>
            {r.note ? <p className="pre-line muted">Note : {r.note}</p> : null}
            {TO_PROCESS.has(r.status) ? (
              <p>
                <button type="button" className="btn btn--secondary btn--small" onClick={() => setTarget(r)}>
                  Marquer comme effectué
                </button>
              </p>
            ) : null}
          </li>
        ))}
      </ul>
      <Pager page={page} total={data?.total ?? 0} pageSize={data?.pageSize ?? 20} onPage={setPage} />
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
          Confirmez que vous avez bien remboursé <strong>{target ? formatCents(target.amountCents) : ''}</strong> à <strong>{target?.buyerEmail ?? 'son payeur'}</strong>. Cette
          déclaration est tracée.
        </p>
        <div className="field">
          <label htmlFor="admin-refund-note">Note (ex. « virement retour effectué le 12/11 »)</label>
          <textarea id="admin-refund-note" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
      </ConfirmDialog>
    </section>
  );
}

function StuckOrders() {
  const [page, setPage] = useState(1);
  const { data, error, isPending, refetch } = useStuckOrders(page);
  const retry = useRetryStuckOrder();
  const [target, setTarget] = useState<StuckOrder | null>(null);
  const tz = userTimeZone();
  return (
    <section className="stack" aria-labelledby="titre-bloquees">
      <h2 id="titre-bloquees">Commandes bloquées</h2>
      <p className="muted">Commandes que l’expiration automatique n’a pas réussi à traiter (5 échecs) : leurs places restent bloquées tant qu’elles ne sont pas relancées.</p>
      {isPending ? <PageLoader shape="text" /> : null}
      <ErrorAlert error={error} onRetry={() => void refetch()} />
      {data && data.items.length === 0 ? <p className="muted">Aucune commande bloquée.</p> : null}
      <ul className="list-reset stack">
        {data?.items.map((o) => (
          <li key={o.id} className="card stack card--attention">
            <p className="row row--between">
              <strong>{o.eventTitle}</strong>
              <span className="badge badge--pending">{lookup(ORDER_STATUS_LABELS, o.status) ?? 'Statut inconnu'}</span>
            </p>
            <p>
              {formatCents(o.totalCents)} · {o.buyerEmail} · {o.paymentMethod === 'CARD' ? 'carte' : 'virement'}
            </p>
            <p className="muted">
              Échéance dépassée depuis le {formatDateTime(o.expiresAt, tz)} · {o.expireFailures} échecs d’expiration
            </p>
            <p>
              <button type="button" className="btn btn--secondary btn--small" onClick={() => setTarget(o)}>
                Relancer
              </button>
            </p>
          </li>
        ))}
      </ul>
      <Pager page={page} total={data?.total ?? 0} pageSize={data?.pageSize ?? 20} onPage={setPage} />
      <ErrorAlert error={retry.error} />
      <ConfirmDialog
        open={target !== null}
        title="Relancer l’expiration de cette commande ?"
        icon="retry"
        confirmLabel="Relancer"
        cancelLabel="Ne rien faire"
        busy={retry.isPending}
        consequences={
          target
            ? [
                'Le compteur d’échecs est remis à zéro : le traitement automatique réessaie au prochain passage.',
                `Si l’échéance est dépassée, la commande (${formatCents(target.totalCents)}, ${target.buyerEmail}) expire et ses places sont libérées.`,
                'L’action est tracée dans le journal.',
              ]
            : []
        }
        onCancel={() => setTarget(null)}
        onConfirm={() => {
          if (target) retry.mutate(target.id, { onSettled: () => setTarget(null) });
        }}
      />
    </section>
  );
}

function Pager({ page, total, pageSize, onPage }: { page: number; total: number; pageSize: number; onPage: (p: number) => void }) {
  if (total <= pageSize) return null;
  return (
    <nav className="row row--between" aria-label="Pagination">
      <button type="button" className="btn btn--secondary btn--small" disabled={page <= 1} onClick={() => onPage(page - 1)}>
        Précédent
      </button>
      <span>
        Page {page} / {Math.ceil(total / pageSize)}
      </span>
      <button type="button" className="btn btn--secondary btn--small" disabled={page * pageSize >= total} onClick={() => onPage(page + 1)}>
        Suivant
      </button>
    </nav>
  );
}
