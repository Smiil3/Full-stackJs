import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { __resetClientForTests, apiRequest, login, logout } from '../../api/client';
import type { Order } from '../../api/types';
import { injectFault, mock } from '../../mocks/core';
import { markPaid, offerToWaitlist } from '../../mocks/domain';
import { DEMO_PASSWORD, IDS } from '../../mocks/state';
import { loadTickets } from '../../offline/tickets';
import { BUYER, renderApp } from '../../test/renderApp';

async function buy(qty = 2) {
  await login(BUYER, DEMO_PASSWORD);
  const order = await apiRequest<Order>('/orders', {
    method: 'POST',
    body: { eventId: IDS.eventConcert, paymentMethod: 'CARD', items: [{ ticketTypeId: IDS.ttFosse, quantity: qty }] },
    headers: { 'Idempotency-Key': crypto.randomUUID() },
  });
  const stored = mock.db.orders.find((o) => o.id === order.id);
  if (stored) await markPaid(stored);
  return order;
}

describe('mes billets', () => {
  it('affiche un QR par billet et le plein écran', async () => {
    const user = userEvent.setup();
    await buy(2);
    await renderApp('/me/tickets');
    expect(await screen.findAllByRole('img', { name: /QR code du billet Fosse/ })).toHaveLength(2);
    await user.click(screen.getAllByRole('button', { name: 'Afficher en plein écran' })[0] as HTMLElement);
    expect(screen.getByRole('dialog', { name: /Billet Garonne/ })).toHaveTextContent('Augmentez la luminosité');
    await user.click(screen.getByRole('button', { name: 'Fermer' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('billet utilisé / annulé : pas de QR, statut affiché', async () => {
    await buy(2);
    const [t1, t2] = mock.db.tickets;
    if (t1) Object.assign(t1, { status: 'USED', usedAt: '2026-11-14T20:04:00.000Z' });
    if (t2) t2.status = 'CANCELLED';
    await renderApp('/me/tickets');
    expect(await screen.findByText('Utilisé le sam. 14 nov. 2026, 21:04')).toBeInTheDocument();
    expect(screen.getByText('Annulé')).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: /QR code/ })).toBeNull();
  });

  it('hors-ligne : affiche la dernière liste enregistrée (sans jeton), purgée à la déconnexion', async () => {
    await buy(1);
    const first = await renderApp('/me/tickets');
    await screen.findAllByRole('img', { name: /QR code/ });
    const saved = await loadTickets(null);
    expect(saved?.tickets).toHaveLength(1);
    expect(JSON.stringify(saved)).not.toMatch(/mock-at-|accessToken|acheteur@example/);
    first.unmount();

    injectFault({ route: 'GET /me/tickets', status: 0, code: 'INTERNAL_ERROR', network: true });
    await renderApp('/me/tickets');
    expect(await screen.findByText(/Hors-ligne : billets enregistrés sur cet appareil/)).toBeInTheDocument();
    expect(screen.getAllByRole('img', { name: /QR code/ })).toHaveLength(1);

    await logout();
    await waitFor(async () => expect(await loadTickets(null)).toBeNull());
  });

  it('M1 : la déconnexion n’est terminée qu’une fois les billets hors-ligne effacés', async () => {
    await buy(1);
    await renderApp('/me/tickets');
    await screen.findAllByRole('img', { name: /QR code/ });
    expect(await loadTickets(null)).not.toBeNull();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Se déconnecter' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Se déconnecter' })).toBeNull());
    expect(await loadTickets(null)).toBeNull();
  });

  it('M2 : résultat hors-ligne remplacé par les données en ligne dès que la session revient', async () => {
    await buy(1);
    const first = await renderApp('/me/tickets');
    await screen.findAllByRole('img', { name: /QR code/ });
    first.unmount();
    __resetClientForTests();
    injectFault({ route: 'POST /auth/refresh', status: 0, code: 'INTERNAL_ERROR', network: true });
    await renderApp('/me/tickets'); // démarrage hors-ligne
    expect(await screen.findByText(/Hors-ligne : billets enregistrés/)).toBeInTheDocument();
    await login(BUYER, DEMO_PASSWORD); // réseau revenu, session restaurée
    await waitFor(() => expect(screen.queryByText(/Hors-ligne : billets enregistrés/)).toBeNull());
    expect(await screen.findAllByRole('img', { name: /QR code/ })).toHaveLength(1);
    expect(screen.queryByText(/Hors-ligne/)).toBeNull();
  });

  it('liste d’attente : offre reçue ⇒ bandeau + acceptation ⇒ commande', async () => {
    const user = userEvent.setup();
    await login(BUYER, DEMO_PASSWORD);
    await apiRequest(`/events/${IDS.eventSoldOut}/ticket-types/${IDS.ttSoldOut}/waitlist`, { method: 'POST', body: { quantity: 1 } });
    const tt = mock.db.ticketTypes.find((t) => t.id === IDS.ttSoldOut);
    if (tt) {
      tt.held -= 2;
      offerToWaitlist(tt);
    }
    const { router } = await renderApp('/me/tickets');
    expect(await screen.findByText(/Places disponibles :/)).toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: 'Accepter et payer' }));
    await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/orders\//));
    expect(await screen.findByRole('button', { name: /Payer/ })).toBeInTheDocument();
  });

  it('liste d’attente : offre expirée ⇒ message OFFER_EXPIRED', async () => {
    const user = userEvent.setup();
    await login(BUYER, DEMO_PASSWORD);
    await apiRequest(`/events/${IDS.eventSoldOut}/ticket-types/${IDS.ttSoldOut}/waitlist`, { method: 'POST', body: { quantity: 1 } });
    const tt = mock.db.ticketTypes.find((t) => t.id === IDS.ttSoldOut);
    if (tt) {
      tt.held -= 2;
      offerToWaitlist(tt);
    }
    await renderApp('/me/tickets');
    injectFault({ route: 'POST /waitlist/:entryId/accept', status: 409, code: 'OFFER_EXPIRED' });
    await user.click(await screen.findByRole('button', { name: 'Accepter et payer' }));
    expect(await screen.findByText('Cette offre de la liste d’attente a expiré.')).toBeInTheDocument();
  });
});
