import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { delay, http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { control, injectFault, mock } from '../../mocks/core';
import { server } from '../../mocks/server';
import { IDS } from '../../mocks/state';
import { BUYER, renderApp } from '../../test/renderApp';

const EVENT_URL = `/events/${IDS.eventConcert}`;

function orderKeys(): string[] {
  const keys: string[] = [];
  server.events.on('request:start', ({ request }) => {
    if (request.method === 'POST' && new URL(request.url).pathname === '/api/v1/orders') keys.push(request.headers.get('Idempotency-Key') ?? '');
  });
  return keys;
}

/** Sélecteur − n + : ajuste la quantité « Fosse » jusqu'à la valeur voulue. */
async function chooseFosse(user: ReturnType<typeof userEvent.setup>, qty: string) {
  const group = await screen.findByRole('group', { name: 'Nombre de places « Fosse »' });
  const current = () => Number(within(group).getByRole('status').textContent);
  while (current() < Number(qty)) await user.click(within(group).getByRole('button', { name: 'Ajouter une place Fosse' }));
  while (current() > Number(qty)) await user.click(within(group).getByRole('button', { name: 'Retirer une place Fosse' }));
}

describe('page événement et commande', () => {
  it('affiche la description en TEXTE (aucun HTML interprété), le tarif early barré et les horaires', async () => {
    await renderApp(EVENT_URL);
    expect(await screen.findByRole('heading', { name: /Garonne Électrique/ })).toBeInTheDocument();
    expect(screen.getByText(/<script>alert\(1\)<\/script> doit rester du texte/)).toBeInTheDocument();
    expect(document.querySelector('script')).toBeNull();
    expect(screen.getByText('25,00 €', { exact: false, selector: '.price-old' })).toBeInTheDocument();
    expect(screen.getAllByText(/heure de Paris \(UTC\+1\)/).length).toBeGreaterThan(0);
  });

  it('anonyme : invite à se connecter avec retour sur l’événement', async () => {
    await renderApp(EVENT_URL);
    const link = await screen.findByRole('link', { name: 'Se connecter pour réserver' });
    expect(link).toHaveAttribute('href', `/login?next=${encodeURIComponent(EVENT_URL)}`);
  });

  it('récapitulatif : frais de service et total affichés avant validation', async () => {
    const user = userEvent.setup();
    await renderApp(EVENT_URL, { as: BUYER });
    await chooseFosse(user, '2');
    const recap = screen.getByRole('region', { name: 'Récapitulatif' });
    // 2 × 18,00 € early ; frais 0,50 € + 2,5 % de 36,00 € = 0,50 + 0,90
    expect(within(recap).getByText('36,00 €', { exact: false })).toBeInTheDocument();
    expect(within(recap).getByText('1,40 €', { exact: false })).toBeInTheDocument();
    expect(within(recap).getByText('37,40 €', { exact: false })).toBeInTheDocument();
  });

  it('commande réussie ⇒ page de la commande avec compte à rebours et bouton Payer', async () => {
    const user = userEvent.setup();
    const { router } = await renderApp(EVENT_URL, { as: BUYER });
    await chooseFosse(user, '1');
    await user.click(screen.getByRole('button', { name: /^Réserver 1 place ·/ }));
    expect(await screen.findByRole('button', { name: /Payer 18,95\s€ par carte/ })).toBeInTheDocument();
    expect(router.state.location.pathname).toMatch(/^\/orders\//);
    expect(screen.getAllByText(/Places réservées encore/).length).toBeGreaterThan(0);
  });

  it('double clic ⇒ UNE seule requête (bouton désactivé pendant l’envoi)', async () => {
    const user = userEvent.setup();
    const keys = orderKeys();
    control.latencyMs = 150;
    await renderApp(EVENT_URL, { as: BUYER });
    await chooseFosse(user, '1');
    const button = screen.getByRole('button', { name: /^Réserver 1 place ·/ });
    await user.dblClick(button);
    await user.click(button);
    await screen.findByRole('button', { name: /Payer/ });
    server.events.removeAllListeners();
    expect(keys).toHaveLength(1);
    expect(mock.db.orders).toHaveLength(1);
  });

  it('Idempotency-Key RÉUTILISÉE après une coupure réseau, nouvelle si le panier change', async () => {
    const user = userEvent.setup();
    const keys = orderKeys();
    await renderApp(EVENT_URL, { as: BUYER });
    await chooseFosse(user, '1');
    injectFault({ route: 'POST /orders', status: 0, code: 'INTERNAL_ERROR', network: true });
    await user.click(screen.getByRole('button', { name: /^Réserver 1 place ·/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Connexion impossible');
    injectFault({ route: 'POST /orders', status: 0, code: 'INTERNAL_ERROR', network: true });
    await user.click(screen.getByRole('button', { name: /^Réserver 1 place ·/ }));
    await waitFor(() => expect(keys).toHaveLength(2));
    expect(keys[1]).toBe(keys[0]);

    await chooseFosse(user, '2');
    await user.click(screen.getByRole('button', { name: /^Réserver 2 places ·/ }));
    await screen.findByRole('button', { name: /Payer/ });
    server.events.removeAllListeners();
    expect(keys).toHaveLength(3);
    expect(keys[2]).not.toBe(keys[0]);
  });

  it('réponse perdue puis nouvel essai avec la même clé ⇒ une seule commande côté serveur', async () => {
    const user = userEvent.setup();
    let first = true;
    server.use(
      http.post('*/api/v1/orders', async () => {
        if (first) {
          first = false;
          await delay(10);
          return HttpResponse.error();
        }
        return undefined; // laisse passer vers le handler normal
      }),
    );
    await renderApp(EVENT_URL, { as: BUYER });
    await chooseFosse(user, '1');
    await user.click(screen.getByRole('button', { name: /^Réserver 1 place ·/ }));
    await screen.findByRole('alert');
    await user.click(screen.getByRole('button', { name: /^Réserver 1 place ·/ }));
    await screen.findByRole('button', { name: /Payer/ });
    expect(mock.db.orders).toHaveLength(1);
  });

  it('SOLD_OUT : message nommant le type de place et disponibilités rafraîchies', async () => {
    const user = userEvent.setup();
    await renderApp(EVENT_URL, { as: BUYER });
    await chooseFosse(user, '1');
    const before = mock.db.calls.get(`GET /events/:eventId`) ?? 0;
    injectFault({ route: 'POST /orders', status: 409, code: 'SOLD_OUT', details: { ticketTypeId: IDS.ttFosse } });
    await user.click(screen.getByRole('button', { name: /^Réserver 1 place ·/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Plus assez de places « Fosse »');
    await waitFor(() => expect(mock.db.calls.get(`GET /events/:eventId`) ?? 0).toBeGreaterThan(before));
  });

  it('H2 : après SOLD_OUT, la quantité du type épuisé n’est plus envoyée (pas de 409 en boucle)', async () => {
    const user = userEvent.setup();
    await renderApp(EVENT_URL, { as: BUYER });
    await chooseFosse(user, '2');
    const fosse = mock.db.ticketTypes.find((t) => t.id === IDS.ttFosse);
    if (fosse) fosse.sold = fosse.capacity - fosse.held; // épuisé entre-temps
    await user.click(screen.getByRole('button', { name: /^Réserver 2 places ·/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Plus assez de places « Fosse »');
    expect(await screen.findByRole('button', { name: 'Choisissez au moins une place' })).toBeDisabled();
    expect(screen.queryByRole('group', { name: 'Nombre de places « Fosse »' })).toBeNull();
    expect(mock.db.calls.get('POST /orders')).toBe(1);
  });

  it('B5 : la clé d’idempotence survit au démontage du formulaire (même panier ⇒ même clé)', async () => {
    const user = userEvent.setup();
    const keys = orderKeys();
    const first = await renderApp(EVENT_URL, { as: BUYER });
    await chooseFosse(user, '1');
    injectFault({ route: 'POST /orders', status: 0, code: 'INTERNAL_ERROR', network: true });
    await user.click(screen.getByRole('button', { name: /^Réserver 1 place ·/ }));
    await screen.findByRole('alert');
    first.unmount();
    await renderApp(EVENT_URL);
    await chooseFosse(user, '1');
    await user.click(await screen.findByRole('button', { name: /^Réserver 1 place ·/ }));
    await screen.findByRole('button', { name: /Payer/ });
    server.events.removeAllListeners();
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
  });

  it('M5 : réponse perdue puis commande EXPIRED ⇒ le même panier crée une NOUVELLE commande, en un seul clic', async () => {
    const user = userEvent.setup();
    const keys = orderKeys();
    const { idempotencyKeyFor, orderFingerprint } = await import('../../api/hooks/orders');
    const { apiRequest, login } = await import('../../api/client');
    const { DEMO_PASSWORD } = await import('../../mocks/state');
    // Simule une 1re tentative dont la réponse s'est perdue : la commande existe côté serveur avec la clé courante…
    const session = await login(BUYER, DEMO_PASSWORD);
    const body = { eventId: IDS.eventConcert, paymentMethod: 'CARD' as const, items: [{ ticketTypeId: IDS.ttFosse, quantity: 1 }] };
    const key = idempotencyKeyFor(session.user.id, orderFingerprint(body));
    await apiRequest('/orders', { method: 'POST', body, headers: { 'Idempotency-Key': key } });
    // … puis expire avant que l'acheteur ne réessaie.
    const stored = mock.db.orders[0];
    if (stored) stored.expiresAt = new Date(Date.now() - 1000).toISOString();

    await renderApp(EVENT_URL);
    await chooseFosse(user, '1');
    await user.click(screen.getByRole('button', { name: /^Réserver 1 place ·/ }));
    await screen.findByRole('button', { name: /Payer/ }); // nouvelle commande, payable
    expect(screen.queryByText(/Le délai de réservation est dépassé/)).toBeNull();
    server.events.removeAllListeners();
    expect(keys[0]).toBe(key); // 1er envoi : même clé ⇒ ancienne commande EXPIRED rendue
    expect(keys.at(-1)).not.toBe(key); // 2e envoi automatique : clé neuve
    expect(mock.db.orders).toHaveLength(2);
  });

  it('LIMIT_EXCEEDED : plafond et places déjà détenues expliqués', async () => {
    const user = userEvent.setup();
    await renderApp(EVENT_URL, { as: BUYER });
    await chooseFosse(user, '1');
    injectFault({ route: 'POST /orders', status: 422, code: 'LIMIT_EXCEEDED', details: { max: 6, alreadyOwned: 6 } });
    await user.click(screen.getByRole('button', { name: /^Réserver 1 place ·/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Vous ne pouvez pas dépasser 6 places. Vous en avez déjà 6.');
  });

  it.each([
    ['SALES_CLOSED', 409, 'La billetterie de cet événement est fermée.'],
    ['PAYMENT_METHOD_UNAVAILABLE', 422, 'Ce mode de paiement n’est pas disponible'],
    ['EMAIL_NOT_VERIFIED', 403, 'Confirmez d’abord votre adresse email'],
    ['RATE_LIMITED', 429, 'Trop de tentatives'],
  ] as const)('%s : message compréhensible', async (code, status, text) => {
    const user = userEvent.setup();
    await renderApp(EVENT_URL, { as: BUYER });
    await chooseFosse(user, '1');
    injectFault({ route: 'POST /orders', status, code });
    await user.click(screen.getByRole('button', { name: /^Réserver 1 place ·/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent(text);
  });

  it('quantité bornée par rules.maxPerOrder (cumul sur les types)', async () => {
    const user = userEvent.setup();
    await renderApp(EVENT_URL, { as: BUYER });
    await chooseFosse(user, '4');
    const balcon = screen.getByRole('group', { name: 'Nombre de places « Balcon »' });
    const add = within(balcon).getByRole('button', { name: 'Ajouter une place Balcon' });
    await user.click(add);
    await user.click(add);
    expect(within(balcon).getByRole('status')).toHaveTextContent('2');
    expect(add).toBeDisabled(); // 4 + 2 = plafond de 6 par commande
  });

  it('virement choisi ⇒ commande en attente de virement avec référence à copier', async () => {
    const user = userEvent.setup();
    await renderApp(EVENT_URL, { as: BUYER });
    await chooseFosse(user, '1');
    await user.click(screen.getByRole('radio', { name: /Virement bancaire/ }));
    await user.click(screen.getByRole('button', { name: /^Réserver 1 place ·/ }));
    expect(await screen.findByRole('heading', { name: 'Instructions de virement' })).toBeInTheDocument();
    expect(screen.getByText(/^NG-[A-Z0-9]{8}$/)).toBeInTheDocument();
    expect(screen.getByText('FR76 3000 6000 0112 3456 7890 189')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copier la référence' })).toBeInTheDocument();
  });

  it('M2 : deux offres expirées sur l’événement ⇒ réinscription refusée avec une explication claire', async () => {
    const user = userEvent.setup();
    const tt = mock.db.ticketTypes.find((t) => t.id === IDS.ttSoldOut);
    for (let i = 0; i < 2; i++) {
      mock.db.waitlist.push({ id: crypto.randomUUID(), userId: IDS.userBuyer, eventId: IDS.eventSoldOut, ticketTypeId: tt?.id ?? '', quantity: 1, status: 'EXPIRED', offerExpiresAt: null, createdAt: new Date().toISOString() });
    }
    await renderApp(`/events/${IDS.eventSoldOut}`, { as: BUYER });
    await user.click(await screen.findByRole('button', { name: 'Rejoindre la liste d’attente' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Vous avez laissé passer deux offres de places pour cet événement');
  });

  it('événement complet ⇒ inscription à la liste d’attente avec position', async () => {
    const user = userEvent.setup();
    await renderApp(`/events/${IDS.eventSoldOut}`, { as: BUYER });
    await user.click(await screen.findByRole('button', { name: 'Rejoindre la liste d’attente' }));
    expect(await screen.findByText(/Vous êtes inscrit·e \(position 1\)/)).toBeInTheDocument();
  });

  it('v1.14 : règles de la liste d’attente expliquées avant l’inscription', async () => {
    await renderApp(`/events/${IDS.eventSoldOut}`, { as: BUYER });
    expect(await screen.findByText(/par ordre d’inscription/)).toHaveTextContent(/première personne de la file est servie en priorité/);
  });

  it('virement indisponible ⇒ option absente (événement en ligne)', async () => {
    await renderApp(`/events/${IDS.eventOnline}`, { as: BUYER });
    await screen.findByRole('heading', { name: 'Session acoustique en ligne' });
    expect(screen.queryByRole('radio', { name: /Virement/ })).toBeNull();
    expect(screen.getAllByText(/heure de New York/).length).toBeGreaterThan(0);
  });
});
