/**
 * Prestataire de paiement simulé pour le mode `dev:mock` : remplace la page hébergée du mock PSP
 * du back. Le « webhook » est appliqué avec un délai pour exercer le polling de GET /orders/:id.
 */
import { mock } from './core';
import { expireDueOrders, markPaid } from './domain';

export const MOCK_WEBHOOK_DELAY_MS = 3000;

export function mockPspPay(orderId: string, outcome: 'success' | 'failed', delayMs = MOCK_WEBHOOK_DELAY_MS): void {
  if (outcome === 'failed') {
    // Paiement refusé : session close, la commande reste PENDING_PAYMENT jusqu'à expiration.
    const order = mock.db.orders.find((o) => o.id === orderId);
    if (order) order.paymentSessionOpen = false;
    return;
  }
  setTimeout(() => {
    expireDueOrders();
    const order = mock.db.orders.find((o) => o.id === orderId);
    if (order?.status === 'PENDING_PAYMENT') void markPaid(order);
  }, delayMs);
}
