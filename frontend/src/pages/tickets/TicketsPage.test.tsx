import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { delay, http } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import { __resetClientForTests, apiRequest, login, logout } from '../../api/client';
import type { Order } from '../../api/types';
import { injectFault, mock } from '../../mocks/core';
import { markPaid, offerToWaitlist } from '../../mocks/domain';
import { server } from '../../mocks/server';
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

  it('M5 : plein écran fermé si le billet devient utilisé ; focus rendu au bouton d’ouverture', async () => {
    const user = userEvent.setup();
    await buy(1);
    const { queryClient } = await renderApp('/me/tickets');
    const openBtn = await screen.findByRole('button', { name: 'Afficher en plein écran' });
    await user.click(openBtn);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    const t = mock.db.tickets[0];
    if (t) Object.assign(t, { status: 'USED', usedAt: new Date().toISOString() });
    await queryClient.invalidateQueries({ queryKey: ['tickets'] });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(await screen.findByText(/^Utilisé le/)).toBeInTheDocument();
  });

  it('M5 : fermeture manuelle ⇒ focus rendu au bouton d’ouverture', async () => {
    const user = userEvent.setup();
    await buy(1);
    await renderApp('/me/tickets');
    await user.click(await screen.findByRole('button', { name: 'Afficher en plein écran' }));
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Afficher en plein écran' })).toHaveFocus());
  });

  it('M4 : verrou d’écran redemandé au retour au premier plan', async () => {
    const user = userEvent.setup();
    const request = vi.fn(() => Promise.resolve({ release: () => Promise.resolve() }));
    Object.defineProperty(navigator, 'wakeLock', { configurable: true, value: { request } });
    await buy(1);
    await renderApp('/me/tickets');
    await user.click(await screen.findByRole('button', { name: 'Afficher en plein écran' }));
    expect(request).toHaveBeenCalledTimes(1);
    document.dispatchEvent(new Event('visibilitychange'));
    expect(request).toHaveBeenCalledTimes(2);
    Reflect.deleteProperty(navigator, 'wakeLock');
  });

  /** Refresh ralenti (puis traité par le serveur simulé) pour observer l'état intermédiaire. */
  const slowRefresh = () =>
    server.use(
      http.post('*/api/v1/auth/refresh', async () => {
        await delay(150);
      }),
    );

  it('F6-M3 : retour du cache avant/arrière avec la session d’un AUTRE compte ⇒ contenu masqué puis purgé', async () => {
    await buy(1);
    await renderApp('/me/tickets');
    expect(await screen.findByRole('img', { name: /QR code du billet Fosse/ })).toBeInTheDocument();
    mock.db.refreshCookie = { token: 'autre-onglet', userId: IDS.userOwner }; // un autre compte s'est connecté
    slowRefresh();
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    expect(await screen.findByText('Vérification de la session…')).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: /QR code/ })).toBeNull(); // masqué immédiatement
    expect(await screen.findByText(/Vous n’avez pas encore de billet/)).toBeInTheDocument(); // billets de l'autre compte : aucun
    expect(screen.queryByRole('img', { name: /QR code/ })).toBeNull();
  });

  it('F6-M3 : retour du cache avant/arrière après fin de session ⇒ plus aucun billet affiché', async () => {
    await buy(1);
    const { router } = await renderApp('/me/tickets');
    await screen.findByRole('img', { name: /QR code du billet Fosse/ });
    mock.db.refreshCookie = null; // session révoquée entre-temps
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/login'));
    expect(screen.queryByRole('img', { name: /QR code/ })).toBeNull();
  });

  it('F6-M3 : page de QR redevenue visible ⇒ QR masqués pendant la revérification, puis réaffichés (même compte)', async () => {
    await buy(1);
    await renderApp('/me/tickets');
    await screen.findByRole('img', { name: /QR code du billet Fosse/ });
    slowRefresh();
    const refreshes = mock.db.calls.get('POST /auth/refresh') ?? 0;
    document.dispatchEvent(new Event('visibilitychange'));
    expect(await screen.findByText('Vérification de la session…')).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: /QR code/ })).toBeNull();
    expect(await screen.findByRole('img', { name: /QR code du billet Fosse/ })).toBeInTheDocument();
    expect(mock.db.calls.get('POST /auth/refresh') ?? 0).toBe(refreshes + 1);
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

  it('v1.14 : acceptation au-delà du plafond par personne ⇒ message LIMIT_EXCEEDED', async () => {
    const user = userEvent.setup();
    await login(BUYER, DEMO_PASSWORD);
    await apiRequest(`/events/${IDS.eventSoldOut}/ticket-types/${IDS.ttSoldOut}/waitlist`, { method: 'POST', body: { quantity: 1 } });
    const tt = mock.db.ticketTypes.find((t) => t.id === IDS.ttSoldOut);
    if (tt) {
      tt.held -= 2;
      offerToWaitlist(tt);
    }
    await renderApp('/me/tickets');
    injectFault({ route: 'POST /waitlist/:entryId/accept', status: 422, code: 'LIMIT_EXCEEDED', details: { max: 6, alreadyOwned: 6 } });
    await user.click(await screen.findByRole('button', { name: 'Accepter et payer' }));
    expect(await screen.findByText('Vous ne pouvez pas dépasser 6 places. Vous en avez déjà 6.')).toBeInTheDocument();
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
