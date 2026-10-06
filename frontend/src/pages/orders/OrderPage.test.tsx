import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import { apiRequest, login } from '../../api/client';
import type { Order } from '../../api/types';
import { injectFault, mock } from '../../mocks/core';
import { markPaid } from '../../mocks/domain';
import { mockPspPay } from '../../mocks/psp';
import { server } from '../../mocks/server';
import { DEMO_PASSWORD, IDS } from '../../mocks/state';
import { BUYER, renderApp } from '../../test/renderApp';

async function createOrder(paymentMethod: 'CARD' | 'TRANSFER' = 'CARD', qty = 1): Promise<Order> {
  await login(BUYER, DEMO_PASSWORD);
  return apiRequest<Order>('/orders', {
    method: 'POST',
    body: { eventId: IDS.eventConcert, paymentMethod, items: [{ ticketTypeId: IDS.ttFosse, quantity: qty }] },
    headers: { 'Idempotency-Key': crypto.randomUUID() },
  });
}

describe('page commande', () => {
  it('retour PSP « success » : ne considère PAS la commande payée sur la foi de l’URL ; poll jusqu’à PAID', async () => {
    const order = await createOrder();
    await renderApp(`/orders/${order.id}?payment=success`);
    expect(await screen.findByText(/Paiement en cours de confirmation/)).toBeInTheDocument();
    expect(screen.queryByText(/Paiement confirmé/)).toBeNull();
    mockPspPay(order.id, 'success', 100); // le « webhook » arrive plus tard
    expect(await screen.findByText(/Paiement confirmé/, {}, { timeout: 5000 })).toBeInTheDocument();
    expect((mock.db.calls.get('GET /orders/:orderId') ?? 0)).toBeGreaterThanOrEqual(2);
  });

  it('H1 : après 60 s sans confirmation, arrêt du polling SANS réafficher « Payer » (pas de double paiement)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const order = await createOrder();
    await renderApp(`/orders/${order.id}?payment=success`);
    await screen.findByText(/Paiement en cours de confirmation/);
    expect(screen.queryByRole('button', { name: /Payer/ })).toBeNull();
    await vi.advanceTimersByTimeAsync(61_000);
    expect(await screen.findByText(/prend plus de temps que prévu/)).toBeInTheDocument();
    const calls = mock.db.calls.get('GET /orders/:orderId') ?? 0;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(mock.db.calls.get('GET /orders/:orderId') ?? 0).toBe(calls); // polling arrêté
    expect(screen.queryByRole('button', { name: /Payer/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Actualiser' })).toBeInTheDocument();
    vi.useRealTimers();
  });

  it('F6-M1 : paiement en cours (serveur, v1.16) puis rechargement ⇒ « Reprendre le paiement », jamais « Payer »', async () => {
    const user = userEvent.setup();
    const order = await createOrder();
    await apiRequest(`/orders/${order.id}/checkout`, { method: 'POST' }); // session de paiement ouverte
    const first = await renderApp(`/orders/${order.id}`);
    expect(await screen.findByText(/Paiement en cours de confirmation/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Payer/ })).toBeNull();
    first.unmount(); // rechargement de la page : aucune mémoire locale, seul le serveur fait foi
    const { router } = await renderApp(`/orders/${order.id}`);
    expect(await screen.findByText(/Paiement en cours de confirmation/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Payer/ })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Reprendre le paiement' }));
    await waitFor(() => expect(router.state.location.pathname).toBe(`/mock-psp/${order.id}`)); // même session
  });

  it('F6-M2 : pas d’annulation tant qu’un paiement est en cours ou en attente de confirmation', async () => {
    const order = await createOrder();
    await apiRequest(`/orders/${order.id}/checkout`, { method: 'POST' });
    const first = await renderApp(`/orders/${order.id}`);
    await screen.findByText(/Paiement en cours de confirmation/);
    expect(screen.queryByRole('button', { name: 'Annuler la commande' })).toBeNull();
    first.unmount();
    const other = await createOrder(); // aucune session ouverte, mais retour « success » du PSP
    await renderApp(`/orders/${other.id}?payment=success`);
    await screen.findByText(/Paiement en cours de confirmation/);
    expect(screen.queryByRole('button', { name: 'Annuler la commande' })).toBeNull();
  });

  it('F6-M1 : paiement refusé chez le PSP (session close) ⇒ nouvel essai possible', async () => {
    const order = await createOrder();
    await apiRequest(`/orders/${order.id}/checkout`, { method: 'POST' });
    mockPspPay(order.id, 'failed');
    await renderApp(`/orders/${order.id}?payment=failed`);
    expect(await screen.findByRole('button', { name: /^Payer/ })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Annuler la commande' })).toBeInTheDocument();
  });

  it('retour PSP « failed » : message et nouvel essai possible', async () => {
    const order = await createOrder();
    await renderApp(`/orders/${order.id}?payment=failed`);
    expect(await screen.findByText(/Le paiement n’a pas abouti/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Payer/ })).toBeEnabled();
  });

  it('Payer ⇒ redirection vers la page du PSP (interne en mode mock)', async () => {
    const user = userEvent.setup();
    const order = await createOrder();
    const { router } = await renderApp(`/orders/${order.id}`);
    await user.click(await screen.findByRole('button', { name: /Payer/ }));
    await waitFor(() => expect(router.state.location.pathname).toBe(`/mock-psp/${order.id}`));
  });

  it('redirectUrl inattendu (autre domaine) ⇒ redirection bloquée', async () => {
    const user = userEvent.setup();
    const before = window.location.href;
    server.use(http.post('*/api/v1/orders/:id/checkout', () => HttpResponse.json({ redirectUrl: 'https://evil.example/pay' })));
    const order = await createOrder();
    const { router } = await renderApp(`/orders/${order.id}`);
    await user.click(await screen.findByRole('button', { name: /Payer/ }));
    expect(await screen.findByText(/la redirection a été bloquée/)).toBeInTheDocument();
    expect(window.location.href).toBe(before);
    expect(router.state.location.pathname).toBe(`/orders/${order.id}`);
  });

  it('ORDER_EXPIRED au paiement ⇒ message clair et statut rafraîchi', async () => {
    const user = userEvent.setup();
    const order = await createOrder();
    await renderApp(`/orders/${order.id}`);
    const pay = await screen.findByRole('button', { name: /Payer/ });
    const stored = mock.db.orders.find((o) => o.id === order.id);
    if (stored) stored.expiresAt = new Date(Date.now() - 1000).toISOString();
    await user.click(pay);
    expect(await screen.findByText(/Le délai de réservation est dépassé/)).toBeInTheDocument();
    expect(await screen.findByRole('link', { name: 'Refaire une réservation' })).toBeInTheDocument();
  });

  it('H3 : compte à rebours sur l’horloge du SERVEUR ; « Payer » reste actif (le serveur tranche)', async () => {
    const order = await createOrder(); // expire dans 15 min (horloge serveur du mock = locale)
    const serverAhead = new Date(Date.now() + 20 * 60_000).toUTCString(); // téléphone en retard de 20 min
    const { recordServerDate } = await import('../../api/serverClock');
    recordServerDate(serverAhead);
    await renderApp(`/orders/${order.id}`);
    expect(await screen.findByText('délai écoulé')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Payer/ })).toBeEnabled();
  });

  it('INVALID_STATE au paiement ⇒ message', async () => {
    const user = userEvent.setup();
    const order = await createOrder();
    await renderApp(`/orders/${order.id}`);
    injectFault({ route: 'POST /orders/:orderId/checkout', status: 409, code: 'INVALID_STATE' });
    await user.click(await screen.findByRole('button', { name: /Payer/ }));
    expect(await screen.findByText('Cette action n’est plus possible pour cette commande.')).toBeInTheDocument();
  });

  it('annulation d’une commande payée : confirmation explicite avec montant remboursé', async () => {
    const user = userEvent.setup();
    const order = await createOrder('CARD', 2);
    const stored = mock.db.orders.find((o) => o.id === order.id);
    if (stored) await markPaid(stored);
    await renderApp(`/orders/${order.id}`);
    await user.click(await screen.findByRole('button', { name: 'Annuler la commande' }));
    const dialog = screen.getByRole('dialog', { name: 'Annuler cette commande ?' });
    expect(dialog).toHaveTextContent(/Montant remboursé : 36,00\s€/);
    expect(mock.db.orders.find((o) => o.id === order.id)?.status).toBe('PAID'); // rien tant que non confirmé
    await user.click(screen.getByRole('button', { name: 'Oui, annuler la commande' }));
    expect(await screen.findByText(/Commande annulée et remboursée : 36,00\s€/)).toBeInTheDocument();
  });

  it('montant remboursé = refundPreviewCents du serveur (frais inclus si remboursables)', async () => {
    const user = userEvent.setup();
    const order = await createOrder('CARD', 1);
    const stored = mock.db.orders.find((o) => o.id === order.id);
    if (stored) {
      stored.serviceFeeRefundable = true;
      stored.refundPercent = 50;
      await markPaid(stored);
    }
    await renderApp(`/orders/${order.id}`);
    await user.click(await screen.findByRole('button', { name: 'Annuler la commande' }));
    // floor(1800 × 50 / 100) + 95 de frais = 995
    expect(screen.getByRole('dialog', { name: 'Annuler cette commande ?' })).toHaveTextContent(/Montant remboursé : 9,95\s€/);
  });

  it('annulation impossible (refundPreviewCents null, ex. billet scanné) ⇒ pas de bouton', async () => {
    const order = await createOrder();
    const stored = mock.db.orders.find((o) => o.id === order.id);
    if (stored) await markPaid(stored);
    const ticket = mock.db.tickets.find((t) => t.orderId === order.id);
    if (ticket) ticket.status = 'USED';
    await renderApp(`/orders/${order.id}`);
    await screen.findByText(/Paiement confirmé/);
    expect(screen.queryByRole('button', { name: 'Annuler la commande' })).toBeNull();
  });

  it('CANCELLATION_CLOSED ⇒ message', async () => {
    const user = userEvent.setup();
    const order = await createOrder();
    const stored = mock.db.orders.find((o) => o.id === order.id);
    if (stored) await markPaid(stored);
    await renderApp(`/orders/${order.id}`);
    await user.click(await screen.findByRole('button', { name: 'Annuler la commande' }));
    injectFault({ route: 'POST /orders/:orderId/cancel', status: 409, code: 'CANCELLATION_CLOSED' });
    await user.click(screen.getByRole('button', { name: 'Oui, annuler la commande' }));
    expect(await screen.findByText('L’annulation n’est plus possible pour cette commande.')).toBeInTheDocument();
  });

  it('commande d’un autre utilisateur ⇒ introuvable', async () => {
    const order = await createOrder();
    await renderApp(`/orders/${order.id}`, { as: 'owner@nuits.test' });
    expect(await screen.findByText('Cet élément est introuvable ou n’est plus disponible.')).toBeInTheDocument();
  });

  it('non connecté ⇒ renvoi vers la connexion avec retour', async () => {
    const id = '0f0e0d0c-0b0a-4908-8706-050403020100';
    const { router } = await renderApp(`/orders/${id}?payment=success`);
    await waitFor(() => expect(router.state.location.pathname).toBe('/login'));
    expect(router.state.location.search).toBe(`?next=${encodeURIComponent(`/orders/${id}?payment=success`)}`);
  });
});
