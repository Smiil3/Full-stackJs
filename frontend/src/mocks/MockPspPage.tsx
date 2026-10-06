import { useNavigate, useParams } from 'react-router';
import { apiPath } from '../api/client';
import { mock } from './core';
import { mockPspPay } from './psp';
import { formatCents } from '../lib/money';

/** Page de paiement SIMULÉE (mode mock uniquement, jamais présente dans le build). */
export function MockPspPage() {
  const { orderId = '' } = useParams();
  const navigate = useNavigate();
  const order = mock.db.orders.find((o) => o.id === orderId);
  const go = (outcome: 'success' | 'failed') => {
    mockPspPay(orderId, outcome);
    void navigate(`${apiPath`/orders/${orderId}`}?payment=${outcome}`, { replace: true });
  };
  return (
    <section className="page narrow">
      <p className="alert alert--warning">Prestataire de paiement SIMULÉ (mode démo).</p>
      <h1>Paiement</h1>
      <p>Montant : {order ? formatCents(order.totalCents) : '—'}</p>
      <button type="button" className="btn btn--block" onClick={() => go('success')}>
        Payer
      </button>
      <button type="button" className="btn btn--secondary btn--block" onClick={() => go('failed')}>
        Refuser le paiement
      </button>
    </section>
  );
}
