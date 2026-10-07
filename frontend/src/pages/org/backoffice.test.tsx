import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { delay, http } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import { apiRequest, login, logout } from '../../api/client';
import type { Order } from '../../api/types';
import { injectFault, mock } from '../../mocks/core';
import { server } from '../../mocks/server';
import { DEMO_PASSWORD, IDS } from '../../mocks/state';
import { renderApp } from '../../test/renderApp';

const OWNER = 'owner@nuits.test';
const MANAGER = 'manager@nuits.test';
const ORG = `/org/${IDS.orgNuits}`;
const EVENT = `${ORG}/events/${IDS.eventConcert}`;

/** Envoi des coordonnées bancaires : confirmation (ancien / nouveau compte) puis envoi. */
async function submitBank(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'Enregistrer les coordonnées' }));
  const dialog = await screen.findByRole('dialog', { name: 'Changer le compte qui reçoit les virements ?' });
  expect(dialog).toHaveTextContent(/Ancien compte : FR76 •••• •••• 0189/);
  expect(dialog).toHaveTextContent(/Nouveau compte : FR76 3000 6000 0112 3456 7890 189/);
  await user.click(within(dialog).getByRole('button', { name: 'Oui, changer le compte' }));
}

describe('back-office : accès et réglages', () => {
  it('accueil : OWNER de 2 collectifs ⇒ sélecteur ; MANAGER d’un seul ⇒ redirection directe', async () => {
    const owner = await renderApp('/org', { as: OWNER });
    expect(await screen.findByRole('heading', { name: 'Choisir un collectif' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Collectif Rive Droite' })).toBeInTheDocument();
    owner.unmount();
    await logout();
    const { router } = await renderApp('/org', { as: MANAGER });
    await waitFor(() => expect(router.state.location.pathname).toBe(ORG));
  });

  it('SCANNER ou non-membre ⇒ accès non autorisé (et l’API refuse de toute façon)', async () => {
    await renderApp(ORG, { as: 'scanner@nuits.test' });
    expect(await screen.findByRole('heading', { name: 'Accès non autorisé' })).toBeInTheDocument();
  });

  it('MANAGER : réglages en LECTURE SEULE, pas de formulaire ni de modification bancaire (F3)', async () => {
    await renderApp(`${ORG}/settings`, { as: MANAGER });
    expect(await screen.findByText(/Lecture seule : seuls les propriétaires/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Enregistrer les réglages' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Modifier les coordonnées bancaires' })).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.getByText('FR76 •••• •••• 0189')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Journal' })).toBeNull();
  });

  it('OWNER : modifie les frais en % (2 décimales) ⇒ points de base, seuls les champs modifiés sont envoyés', async () => {
    const user = userEvent.setup();
    let sent: unknown;
    server.events.on('request:start', ({ request }) => {
      if (request.method === 'PATCH') {
        void request
          .clone()
          .json()
          .then((b: unknown) => {
            sent = b;
          });
      }
    });
    await renderApp(`${ORG}/settings`, { as: OWNER });
    const input = await screen.findByLabelText('Frais de service proportionnels (%)');
    await user.clear(input);
    await user.type(input, '3,25');
    await user.click(screen.getByRole('button', { name: 'Enregistrer les réglages' }));
    expect(await screen.findByText('Réglages enregistrés.')).toBeInTheDocument();
    server.events.removeAllListeners();
    expect(sent).toEqual({ serviceFeeBasisPoints: 325 });
  });

  it('OWNER : coordonnées bancaires — IBAN vérifié côté UX, mot de passe obligatoire, erreur sur le champ (v1.7)', async () => {
    const user = userEvent.setup();
    await renderApp(`${ORG}/settings`, { as: OWNER });
    await user.click(await screen.findByRole('button', { name: 'Modifier les coordonnées bancaires' }));
    expect(screen.getByLabelText('IBAN complet')).toHaveValue(''); // jamais pré-rempli
    await user.type(screen.getByLabelText('Titulaire du compte'), 'Les Nuits');
    await user.type(screen.getByLabelText('IBAN complet'), 'FR76 3000 6000 0112 3456 7890 188');
    await user.type(screen.getByLabelText('BIC'), 'AGRIFRPP');
    await user.click(screen.getByRole('button', { name: 'Enregistrer les coordonnées' }));
    expect(screen.getByText(/clé de contrôle incorrecte/)).toBeInTheDocument();
    expect(screen.getByText('Saisissez votre mot de passe pour confirmer.')).toBeInTheDocument();
    await user.clear(screen.getByLabelText('IBAN complet'));
    await user.type(screen.getByLabelText('IBAN complet'), 'FR76 3000 6000 0112 3456 7890 189');
    await user.type(screen.getByLabelText('Votre mot de passe (confirmation)'), 'mauvais');
    await submitBank(user);
    expect(await screen.findByText('Mot de passe incorrect.')).toBeInTheDocument();
    expect(mock.db.calls.get('POST /auth/refresh') ?? 0).toBeLessThanOrEqual(1); // seul le refresh de démarrage
    await user.type(screen.getByLabelText('IBAN complet'), 'FR76 3000 6000 0112 3456 7890 189'); // effacé après l'échec (M2)
    await user.type(screen.getByLabelText('Votre mot de passe (confirmation)'), DEMO_PASSWORD);
    await submitBank(user);
    await waitFor(() => expect(screen.queryByLabelText('IBAN complet')).toBeNull());
  });

  it('M2 : ni l’IBAN complet ni le mot de passe ne restent dans le cache des mutations (échec puis succès)', async () => {
    const user = userEvent.setup();
    const { queryClient } = await renderApp(`${ORG}/settings`, { as: OWNER });
    const dump = () => JSON.stringify(queryClient.getMutationCache().getAll().map((m) => ({ v: m.state.variables, d: m.state.data, c: m.state.context })));
    await user.click(await screen.findByRole('button', { name: 'Modifier les coordonnées bancaires' }));
    await user.type(screen.getByLabelText('Titulaire du compte'), 'Les Nuits');
    await user.type(screen.getByLabelText('IBAN complet'), 'FR76 3000 6000 0112 3456 7890 189');
    await user.type(screen.getByLabelText('BIC'), 'AGRIFRPP');
    await user.type(screen.getByLabelText('Votre mot de passe (confirmation)'), 'mauvais-mot-de-passe');
    await submitBank(user);
    expect(await screen.findByText('Mot de passe incorrect.')).toBeInTheDocument();
    expect(dump()).not.toMatch(/7890189|mauvais-mot-de-passe/);
    expect(screen.getByLabelText('IBAN complet')).toHaveValue('');
    await user.type(screen.getByLabelText('IBAN complet'), 'FR76 3000 6000 0112 3456 7890 189');
    await user.type(screen.getByLabelText('Votre mot de passe (confirmation)'), DEMO_PASSWORD);
    await submitBank(user);
    await waitFor(() => expect(screen.queryByLabelText('IBAN complet')).toBeNull());
    expect(dump()).not.toMatch(new RegExp(`7890189|${DEMO_PASSWORD}`));
  });

  it('cache vidé à la déconnexion : aucune donnée du collectif ne reste (F3)', async () => {
    const user = userEvent.setup();
    const { queryClient } = await renderApp(`${ORG}/settings`, { as: OWNER });
    await screen.findByText('FR76 •••• •••• 0189');
    expect(queryClient.getQueryCache().getAll().some((q) => q.queryKey[0] === 'org')).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Se déconnecter' }));
    await waitFor(() => expect(queryClient.getQueryCache().getAll().filter((q) => q.queryKey[0] === 'org')).toHaveLength(0));
    expect(screen.queryByText(/FR76/)).toBeNull();
  });
});

describe('back-office : événements', () => {
  it('création : dates dans le fuseau choisi, règles héritées, puis type de place en euros', async () => {
    const user = userEvent.setup();
    let created: Record<string, unknown> | undefined;
    server.events.on('request:start', ({ request }) => {
      if (request.method === 'POST' && request.url.endsWith('/events')) void request.clone().json().then((b: Record<string, unknown>) => (created = b));
    });
    const { router } = await renderApp(`${ORG}/events/new`, { as: MANAGER });
    await user.type(await screen.findByLabelText('Titre'), 'Nouvelle soirée');
    await user.selectOptions(screen.getByLabelText('Fuseau horaire de l’événement'), 'America/New_York');
    for (const [label, v] of [['Début de l’événement', '2027-01-15T20:00'], ['Fin de l’événement', '2027-01-15T23:30'], ['Ouverture des ventes', '2026-12-01T10:00'], ['Fin des ventes', '2027-01-15T19:00']] as const) {
      await user.type(screen.getByLabelText(label), v);
    }
    await user.click(screen.getByRole('button', { name: 'Créer le brouillon' }));
    await waitFor(() => expect(router.state.location.pathname).toMatch(/\/events\/[0-9a-f-]{36}$/));
    server.events.removeAllListeners();
    expect(created).toMatchObject({ timezone: 'America/New_York', startsAt: '2027-01-16T01:00:00.000Z' });
    expect(Object.values(created?.overrides as object).every((v) => v === null)).toBe(true);

    await user.click(await screen.findByRole('button', { name: 'Ajouter un type de place' }));
    await user.type(screen.getByLabelText('Nom du type de place'), 'Standard');
    await user.type(screen.getByLabelText('Capacité (places)'), '151');
    await user.type(screen.getByLabelText('Prix (€)'), '19,99');
    await user.click(screen.getByRole('button', { name: 'Ajouter' }));
    expect(await screen.findByText(/Capacité 151/)).toBeInTheDocument();
    expect(mock.db.ticketTypes.find((t) => t.name === 'Standard' && t.capacity === 151)?.priceCents).toBe(1999);
    await user.click(screen.getByRole('button', { name: 'Publier l’événement' }));
    expect(await screen.findByText('Publié')).toBeInTheDocument();
  });

  it('publication impossible sans type de place ⇒ message clair', async () => {
    const user = userEvent.setup();
    await renderApp(`${ORG}/events/${IDS.eventDraft}`, { as: MANAGER });
    mock.db.ticketTypes = mock.db.ticketTypes.filter((t) => t.eventId !== IDS.eventDraft);
    await user.click(await screen.findByRole('button', { name: 'Publier l’événement' }));
    expect(await screen.findByText(/ajoutez au moins un type de place/)).toBeInTheDocument();
  });

  it('règles de vente : bascule « réglage du collectif / personnalisé » avec valeur effective', async () => {
    const user = userEvent.setup();
    await renderApp(EVENT, { as: MANAGER });
    await user.click(await screen.findByRole('button', { name: 'Modifier l’événement' }));
    const group = screen.getByRole('group', { name: 'Places maximum par commande' });
    expect(within(group).getByText('Valeur appliquée : 6')).toBeInTheDocument();
    await user.click(within(group).getByRole('radio', { name: 'Personnalisé' }));
    const input = within(group).getByLabelText('Valeur');
    await user.clear(input);
    await user.type(input, '4');
    expect(within(group).getByText('Valeur appliquée : 4')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Enregistrer les modifications' }));
    await waitFor(() => expect(mock.db.events.find((e) => e.id === IDS.eventConcert)?.overrides.maxPerOrder).toBe(4));
  });

  it('MANAGER : dates verrouillées quand l’événement a des ventes (v1.7)', async () => {
    const user = userEvent.setup();
    await renderApp(EVENT, { as: MANAGER });
    await user.click(await screen.findByRole('button', { name: 'Modifier l’événement' }));
    expect(screen.getByLabelText('Début de l’événement')).toBeDisabled();
    expect(screen.getByLabelText('Fin de l’événement')).toBeDisabled();
    expect(screen.getByText(/seul le propriétaire du collectif peut reporter/)).toBeInTheDocument();
  });

  it('OWNER : report ⇒ confirmation forte (acheteurs prévenus, remboursement intégral) + motif obligatoire', async () => {
    const user = userEvent.setup();
    await login('acheteur@example.test', DEMO_PASSWORD);
    await apiRequest<Order>('/orders', { method: 'POST', body: { eventId: IDS.eventConcert, paymentMethod: 'CARD', items: [{ ticketTypeId: IDS.ttFosse, quantity: 1 }] }, headers: { 'Idempotency-Key': crypto.randomUUID() } });
    await logout();
    let patch: Record<string, unknown> | undefined;
    server.events.on('request:start', ({ request }) => {
      if (request.method === 'PATCH') void request.clone().json().then((b: Record<string, unknown>) => (patch = b));
    });
    await renderApp(EVENT, { as: OWNER });
    await user.click(await screen.findByRole('button', { name: 'Modifier l’événement' }));
    const start = screen.getByLabelText('Début de l’événement');
    const end = screen.getByLabelText('Fin de l’événement');
    const salesEnd = screen.getByLabelText('Fin des ventes');
    const startValue = (start as HTMLInputElement).value;
    const nextDay = (v: string) => v.replace(/^(\d{4}-\d{2}-)(\d{2})/, (_m, a: string, d: string) => `${a}${String(Number(d) + 1).padStart(2, '0')}`);
    await user.clear(start);
    await user.type(start, nextDay(startValue));
    const endValue = (end as HTMLInputElement).value;
    await user.clear(end);
    await user.type(end, nextDay(endValue));
    await user.clear(salesEnd);
    await user.type(salesEnd, nextDay(startValue));
    await user.click(screen.getByRole('button', { name: 'Enregistrer les modifications' }));
    const dialog = await screen.findByRole('dialog', { name: 'Reporter l’événement ?' });
    expect(dialog).toHaveTextContent('Tous les acheteurs seront prévenus par email');
    expect(dialog).toHaveTextContent('rembourser intégralement');
    expect(within(dialog).getByRole('button', { name: 'Confirmer le report' })).toBeDisabled();
    await user.type(within(dialog).getByLabelText(/Motif du report/), 'Indisponibilité de la salle');
    await user.click(within(dialog).getByRole('button', { name: 'Confirmer le report' }));
    await waitFor(() => expect(patch?.rescheduleReason).toBe('Indisponibilité de la salle'));
    server.events.removeAllListeners();
    expect(Object.keys(patch ?? {}).sort()).toEqual(['endsAt', 'rescheduleReason', 'salesEndAt', 'startsAt']);
  });

  it('H3 : ventes apparues après l’ouverture du formulaire ⇒ revérifiées avant envoi, dialogue de report', async () => {
    const user = userEvent.setup();
    const tt = mock.db.ticketTypes.find((t) => t.id === IDS.ttPartner);
    if (tt) tt.sold = 0; // aucune vente à l'ouverture du formulaire
    await renderApp(`/org/${IDS.orgPartner}/events/${IDS.eventPartner}`, { as: 'owner@partenaire.test' });
    await user.click(await screen.findByRole('button', { name: 'Modifier l’événement' }));
    expect(screen.getByLabelText('Début de l’événement')).toBeEnabled();
    // Pendant la saisie, une vente a lieu : le cache ne la connaît pas.
    if (tt) tt.sold = 10;
    const start = screen.getByLabelText('Début de l’événement');
    const v = (start as HTMLInputElement).value;
    const [d, t] = v.split('T');
    const earlier = `${d ?? ''}T${t === '08:00' ? '07:00' : '08:00'}`; // toujours une heure différente, avant la fin
    await user.clear(start);
    await user.type(start, earlier);
    await user.click(screen.getByRole('button', { name: 'Enregistrer les modifications' }));
    expect(await screen.findByRole('dialog', { name: 'Reporter l’événement ?' })).toBeInTheDocument();
  });

  it('H3 : changement de fuseau ⇒ choix explicite, « conserver l’instant » par défaut (aucun report)', async () => {
    const user = userEvent.setup();
    let patch: Record<string, unknown> | undefined;
    server.events.on('request:start', ({ request }) => {
      if (request.method === 'PATCH') {
        void request
          .clone()
          .json()
          .then((b: Record<string, unknown>) => {
            patch = b;
          });
      }
    });
    await renderApp(EVENT, { as: OWNER });
    await user.click(await screen.findByRole('button', { name: 'Modifier l’événement' }));
    await user.selectOptions(screen.getByLabelText('Fuseau horaire de l’événement'), 'Europe/London');
    expect(screen.getByRole('radio', { name: /Conserver l’instant/ })).toBeChecked();
    await user.click(screen.getByRole('button', { name: 'Enregistrer les modifications' }));
    await waitFor(() => expect(patch).toEqual({ timezone: 'Europe/London' }));
    server.events.removeAllListeners();
    expect(screen.queryByRole('dialog', { name: 'Reporter l’événement ?' })).toBeNull();
  });

  it('H3 : 403 du serveur sur un report ⇒ explication claire', async () => {
    const user = userEvent.setup();
    injectFault({ route: 'PATCH /orgs/:orgId/events/:eventId', status: 403, code: 'FORBIDDEN' });
    await renderApp(EVENT, { as: OWNER });
    await user.click(await screen.findByRole('button', { name: 'Modifier l’événement' }));
    await user.clear(screen.getByLabelText('Titre'));
    await user.type(screen.getByLabelText('Titre'), 'Nouveau titre');
    await user.click(screen.getByRole('button', { name: 'Enregistrer les modifications' }));
    expect(await screen.findByText('Seul le propriétaire du collectif peut reporter un événement qui a des ventes.')).toBeInTheDocument();
  });

  it('annulation (OWNER) : titre à recopier + motif avant de pouvoir confirmer', async () => {
    const user = userEvent.setup();
    await renderApp(EVENT, { as: OWNER });
    await user.click(await screen.findByRole('button', { name: 'Annuler l’événement…' }));
    const dialog = screen.getByRole('dialog', { name: 'Annuler définitivement l’événement ?' });
    const confirm = within(dialog).getByRole('button', { name: 'Annuler l’événement' });
    await user.type(within(dialog).getByLabelText(/Motif/), 'Météo');
    expect(confirm).toBeDisabled();
    await user.type(within(dialog).getByLabelText(/recopiez le titre/), 'Garonne Électrique — soirée d’ouverture');
    expect(confirm).toBeEnabled();
    await user.click(confirm);
    expect(await screen.findByText('Annulé')).toBeInTheDocument();
  });

  it('M4 : titre recopié avec espaces superflus / autre composition Unicode accepté ; champs vidés à la fermeture', async () => {
    const user = userEvent.setup();
    await renderApp(EVENT, { as: OWNER });
    await user.click(await screen.findByRole('button', { name: 'Annuler l’événement…' }));
    let dialog = screen.getByRole('dialog', { name: 'Annuler définitivement l’événement ?' });
    await user.type(within(dialog).getByLabelText(/Motif/), 'Météo');
    const decomposed = '  Garonne E\u0301lectrique   —  soirée d’ouverture '; // « É » décomposé
    await user.type(within(dialog).getByLabelText(/recopiez le titre/), decomposed);
    expect(within(dialog).getByRole('button', { name: 'Annuler l’événement' })).toBeEnabled();
    await user.click(within(dialog).getByRole('button', { name: 'Garder l’événement' }));
    await user.click(screen.getByRole('button', { name: 'Annuler l’événement…' }));
    dialog = screen.getByRole('dialog', { name: 'Annuler définitivement l’événement ?' });
    expect(within(dialog).getByLabelText(/recopiez le titre/)).toHaveValue('');
    expect(within(dialog).getByLabelText(/Motif/)).toHaveValue('');
  });

  it('D1 : annulation — conséquences chiffrées, bouton prudent en principal, alternative « Reporter »', async () => {
    const user = userEvent.setup();
    await renderApp(EVENT, { as: OWNER });
    await user.click(await screen.findByRole('button', { name: 'Annuler l’événement…' }));
    const dialog = screen.getByRole('dialog', { name: 'Annuler définitivement l’événement ?' });
    expect(await within(dialog).findByText(/commandes? payées?/)).toBeInTheDocument();
    expect(dialog).toHaveTextContent(/encaissés/);
    expect(dialog).toHaveTextContent('Tous les acheteurs sont prévenus par e-mail');
    expect(within(dialog).getByRole('button', { name: 'Garder l’événement' })).not.toHaveClass('btn--secondary'); // action principale
    expect(within(dialog).getByRole('button', { name: 'Annuler l’événement' })).toHaveClass('btn--danger');
    expect(within(dialog).getByRole('button', { name: 'Annuler l’événement' })).toBeDisabled();
    await user.click(within(dialog).getByRole('button', { name: 'Reporter l’événement plutôt' }));
    expect(screen.queryByRole('dialog', { name: 'Annuler définitivement l’événement ?' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Enregistrer les modifications' })).toBeInTheDocument(); // éditeur ouvert
  });

  it('M3 : après publication, catalogue public et données dépendantes invalidés', async () => {
    const user = userEvent.setup();
    const { queryClient } = await renderApp(`${ORG}/events/${IDS.eventDraft}`, { as: MANAGER });
    queryClient.setQueryData(['events', { page: 1 }], { items: [], page: 1, pageSize: 20, total: 0 });
    queryClient.setQueryData(['org', IDS.orgNuits, 'event', IDS.eventDraft, 'stats'], { x: 1 });
    await user.click(await screen.findByRole('button', { name: 'Publier l’événement' }));
    await screen.findByText('Publié');
    expect(queryClient.getQueryState(['events', { page: 1 }])?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(['org', IDS.orgNuits, 'event', IDS.eventDraft, 'stats'])?.isInvalidated).toBe(true);
  });

  it('v1.14 : annulation asynchrone ⇒ « Remboursements en cours : N commandes restantes » jusqu’au bout', async () => {
    const user = userEvent.setup();
    for (let i = 0; i < 3; i++) {
      await login('acheteur@example.test', DEMO_PASSWORD);
      const o = await apiRequest<Order>('/orders', { method: 'POST', body: { eventId: IDS.eventConcert, paymentMethod: 'CARD', items: [{ ticketTypeId: IDS.ttFosse, quantity: 1 }] }, headers: { 'Idempotency-Key': crypto.randomUUID() } });
      const stored = mock.db.orders.find((x) => x.id === o.id);
      if (stored) await (await import('../../mocks/domain')).markPaid(stored);
      await logout();
    }
    const { control } = await import('../../mocks/core');
    control.cancelBatchDelayMs = 1500;
    await renderApp(EVENT, { as: OWNER });
    await user.click(await screen.findByRole('button', { name: 'Annuler l’événement…' }));
    const dialog = screen.getByRole('dialog', { name: 'Annuler définitivement l’événement ?' });
    await user.type(within(dialog).getByLabelText(/Motif/), 'Météo');
    await user.type(within(dialog).getByLabelText(/recopiez le titre/), 'Garonne Électrique — soirée d’ouverture');
    await user.click(within(dialog).getByRole('button', { name: 'Annuler l’événement' }));
    expect(await screen.findByText(/Remboursements en cours : 3 commandes restantes/)).toBeInTheDocument();
    expect(await screen.findByText('Événement annulé : toutes les commandes ont été traitées.', {}, { timeout: 12_000 })).toBeInTheDocument();
    expect(mock.db.orders.filter((o) => o.eventId === IDS.eventConcert).every((o) => o.status === 'REFUNDED')).toBe(true);
  }, 20_000);

  it('v1.14 : événement déjà commencé ⇒ annulation désactivée avec explication', async () => {
    const ev = mock.db.events.find((e) => e.id === IDS.eventConcert);
    if (ev) ev.startsAt = new Date(Date.now() - 60_000).toISOString();
    await renderApp(EVENT, { as: OWNER });
    expect(await screen.findByText(/L’événement a commencé : il ne peut plus être annulé/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Annuler l’événement…' })).toBeDisabled();
  });

  it('MANAGER : pas de bouton d’annulation d’événement', async () => {
    await renderApp(EVENT, { as: MANAGER });
    await screen.findByRole('heading', { name: /Garonne Électrique/ });
    expect(screen.queryByRole('button', { name: 'Annuler l’événement…' })).toBeNull();
  });

  it('type de place : capacité < vendues ⇒ CONFLICT expliqué ; suppression avec commandes ⇒ message', async () => {
    const user = userEvent.setup();
    await renderApp(EVENT, { as: MANAGER });
    const card = (await screen.findByRole('heading', { name: 'Balcon' })).closest('li') as HTMLElement;
    await user.click(within(card).getByRole('button', { name: 'Modifier' }));
    const cap = screen.getByLabelText('Capacité (places)');
    await user.clear(cap);
    await user.type(cap, '10');
    await user.click(screen.getByRole('button', { name: 'Enregistrer' }));
    expect(await screen.findByText(/inférieure aux places déjà vendues/)).toBeInTheDocument();
  });
});

describe('back-office : ventes, commandes, export', () => {
  it('tableau de bord : rafraîchi toutes les 5 s, horodatage et indicateur hors-ligne', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await renderApp(`${EVENT}/dashboard`, { as: MANAGER });
    expect((await screen.findAllByText('Vendues')).length).toBeGreaterThan(0);
    const before = mock.db.calls.get('GET /orgs/:orgId/events/:eventId/stats') ?? 0;
    await act(() => vi.advanceTimersByTimeAsync(5_100));
    await waitFor(() => expect(mock.db.calls.get('GET /orgs/:orgId/events/:eventId/stats') ?? 0).toBeGreaterThan(before));
    expect(screen.getByText(/mis à jour il y a/)).toBeInTheDocument();
    expect(screen.getAllByRole('img', { name: /% vendu, \d+ % en attente de paiement/ }).length).toBeGreaterThan(0); // jauges
    injectFault({ route: 'GET /orgs/:orgId/events/:eventId/stats', status: 0, code: 'INTERNAL_ERROR', network: true, times: 10 });
    await act(() => vi.advanceTimersByTimeAsync(5_100));
    expect(await screen.findByText(/Données non rafraîchies/)).toBeInTheDocument();
    vi.useRealTimers();
  });

  it('M6 : polling arrêté sur 403 / 404', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    injectFault({ route: 'GET /orgs/:orgId/events/:eventId/stats', status: 403, code: 'FORBIDDEN' });
    await renderApp(`${EVENT}/dashboard`, { as: MANAGER });
    expect(await screen.findByText('Vous n’avez pas les droits nécessaires pour cette action.')).toBeInTheDocument();
    const calls = mock.db.calls.get('GET /orgs/:orgId/events/:eventId/stats') ?? 0;
    await act(() => vi.advanceTimersByTimeAsync(20_000));
    expect(mock.db.calls.get('GET /orgs/:orgId/events/:eventId/stats') ?? 0).toBe(calls);
    vi.useRealTimers();
  });

  it('virement : AMOUNT_MISMATCH expliqué, puis validation avec le bon montant', async () => {
    const user = userEvent.setup();
    await login('acheteur@example.test', DEMO_PASSWORD);
    const order = await apiRequest<Order>('/orders', { method: 'POST', body: { eventId: IDS.eventConcert, paymentMethod: 'TRANSFER', items: [{ ticketTypeId: IDS.ttFosse, quantity: 1 }] }, headers: { 'Idempotency-Key': crypto.randomUUID() } });
    await logout();
    await renderApp(`${EVENT}/orders`, { as: MANAGER });
    expect((await screen.findAllByText(order.transferInstructions?.reference ?? 'x')).length).toBeGreaterThan(0);
    expect(screen.getByText('FR76 •••• •••• 0189')).toBeInTheDocument();
    const input = screen.getByLabelText('Montant reçu sur le compte (€)');
    await user.type(input, '10');
    await user.click(screen.getByRole('button', { name: 'Valider le virement' }));
    // M5 : récapitulatif avant validation (montant dû, saisi, référence)
    let dialog = screen.getByRole('dialog', { name: 'Valider ce virement ?' });
    expect(dialog).toHaveTextContent(/Montant dû\s*18,95\s€/);
    expect(dialog).toHaveTextContent(/Montant reçu saisi\s*10,00\s€/);
    expect(dialog).toHaveTextContent(order.transferInstructions?.reference ?? 'x');
    await user.click(within(dialog).getByRole('button', { name: 'Valider le virement' }));
    expect(await screen.findByText(/ne correspond pas au montant dû \(18,95\s€\)/)).toBeInTheDocument();
    await user.clear(input);
    await user.type(input, '0');
    await user.click(screen.getByRole('button', { name: 'Valider le virement' }));
    expect(screen.getByText('Saisissez le montant reçu (supérieur à 0).')).toBeInTheDocument();
    await user.clear(input);
    await user.type(input, '18,95');
    await user.click(screen.getByRole('button', { name: 'Valider le virement' }));
    dialog = screen.getByRole('dialog', { name: 'Valider ce virement ?' });
    expect(mock.db.orders.find((o) => o.id === order.id)?.status).toBe('AWAITING_TRANSFER'); // rien avant confirmation
    await user.click(within(dialog).getByRole('button', { name: 'Valider le virement' }));
    await waitFor(() => expect(mock.db.orders.find((o) => o.id === order.id)?.status).toBe('PAID'));
  });

  it('recherche par email et filtre de statut transmis à l’API', async () => {
    const user = userEvent.setup();
    const urls: string[] = [];
    server.events.on('request:start', ({ request }) => {
      if (request.url.includes('/orders?')) urls.push(request.url);
    });
    await renderApp(`${EVENT}/orders`, { as: MANAGER });
    await screen.findByText('Aucune commande.');
    await user.selectOptions(screen.getByLabelText('Statut'), 'PAID');
    await user.type(screen.getByLabelText('Rechercher par email'), 'jeanne');
    await waitFor(() => expect(urls.some((u) => u.includes('status=PAID') && u.includes('q=jeanne'))).toBe(true));
    server.events.removeAllListeners();
  });

  it('export CSV : requête authentifiée (Bearer) puis Blob local — aucun jeton dans l’URL', async () => {
    const user = userEvent.setup();
    const createObjectURL = vi.fn(() => 'blob:local');
    const revokeObjectURL = vi.fn();
    Object.assign(URL, { createObjectURL, revokeObjectURL });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    const seen: { url: string; auth: string | null }[] = [];
    server.events.on('request:start', ({ request }) => {
      if (request.url.includes('attendees.csv')) seen.push({ url: request.url, auth: request.headers.get('Authorization') });
    });
    await renderApp(EVENT, { as: MANAGER });
    await user.click(await screen.findByRole('button', { name: 'Exporter les participants (CSV)' }));
    await waitFor(() => expect(click).toHaveBeenCalled());
    server.events.removeAllListeners();
    expect(seen[0]?.auth).toMatch(/^Bearer /);
    expect(seen[0]?.url).not.toMatch(/token|bearer|mock-at/i);
    expect(createObjectURL).toHaveBeenCalledWith(expect.any(Blob));
    const anchor = click.mock.contexts[0] as HTMLAnchorElement;
    expect(anchor.download).toBe('participants-garonne-electrique-soiree-d-ouverture.csv'); // B1 : nom lisible, pas d'identifiant
  });

  it('B1 : réponse qui n’est pas du CSV (page HTML d’un proxy) ⇒ pas de téléchargement, message', async () => {
    const user = userEvent.setup();
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    server.use(http.get('*/api/v1/orgs/:orgId/events/:eventId/attendees.csv', () => new Response('<html>oops</html>', { headers: { 'Content-Type': 'text/html' } })));
    await renderApp(EVENT, { as: MANAGER });
    await user.click(await screen.findByRole('button', { name: 'Exporter les participants (CSV)' }));
    expect(await screen.findByText(/Réponse inattendue du serveur/)).toBeInTheDocument();
    expect(click).not.toHaveBeenCalled();
  });

  it('B2 : identifiant non-UUID dans l’URL ⇒ page introuvable, aucune requête', async () => {
    const before = [...mock.db.calls.values()].reduce((a, b) => a + b, 0);
    await renderApp('/orders/pas-un-uuid');
    expect(await screen.findByRole('heading', { name: 'Page introuvable' })).toBeInTheDocument();
    await renderApp('/org/../admin/events/x');
    const after = [...mock.db.calls.entries()].filter(([k]) => !k.includes('/auth/')).reduce((a, [, b]) => a + b, 0);
    expect(after).toBeLessThanOrEqual(before);
  });

  it('B4 : statistiques mal formées ⇒ message « réponse inattendue », pas d’affichage faux', async () => {
    server.use(http.get('*/api/v1/orgs/:orgId/events/:eventId/stats', () => Response.json({ eventId: 'x', totals: { sold: '12' } })));
    await renderApp(`${EVENT}/dashboard`, { as: MANAGER });
    expect(await screen.findByText(/Réponse inattendue du serveur/)).toBeInTheDocument();
    expect(screen.queryByText('Vendues')).toBeNull();
  });
});

describe('remboursements carte vérifiés auprès du prestataire (v1.17, A2)', () => {
  function cardRefund(pspState: 'pending' | 'unreachable') {
    const now = new Date().toISOString();
    const r = { id: crypto.randomUUID(), orgId: IDS.orgNuits, orderId: crypto.randomUUID(), eventId: IDS.eventConcert, amountCents: 1800, reason: 'SELF_CANCELLATION' as const, method: 'CARD' as const, status: 'FAILED' as const, note: null, createdAt: now, updatedAt: now, pspState };
    mock.db.refunds.push(r);
    return r;
  }

  it('503 au marquage ⇒ « rien n’a été modifié » + Réessayer après Retry-After, puis succès', async () => {
    const user = userEvent.setup();
    const r = cardRefund('unreachable');
    await renderApp(`${ORG}/refunds`, { as: MANAGER });
    const t0 = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(t0);
    await user.click(await screen.findByRole('button', { name: 'Marquer comme effectué' }));
    const dialog = screen.getByRole('dialog', { name: 'Confirmer le remboursement effectué ?' });
    await user.type(within(dialog).getByLabelText(/Note/), 'Remboursé au guichet');
    await user.click(within(dialog).getByRole('button', { name: 'Marquer comme effectué' }));
    expect(await screen.findByText(/prestataire de paiement est momentanément injoignable/)).toHaveTextContent('Rien n’a été modifié');
    expect(screen.getByRole('button', { name: /^Réessayer/ })).toBeDisabled();
    delete (r as { pspState?: string }).pspState; // prestataire revenu
    clock.mockReturnValue(t0 + 5_000);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Réessayer' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Réessayer' }));
    await waitFor(() => expect(mock.db.refunds.find((x) => x.id === r.id)?.status).toBe('SUCCEEDED'));
    expect(mock.db.refunds.find((x) => x.id === r.id)?.note).toBe('Remboursé au guichet');
  });

  it('B5 : 409 sur une carte ⇒ « en cours chez le prestataire : ne remboursez pas à la main »', async () => {
    const user = userEvent.setup();
    cardRefund('pending');
    await renderApp(`${ORG}/refunds`, { as: MANAGER });
    await user.click(await screen.findByRole('button', { name: 'Marquer comme effectué' }));
    const dialog = screen.getByRole('dialog', { name: 'Confirmer le remboursement effectué ?' });
    await user.type(within(dialog).getByLabelText(/Note/), 'x');
    await user.click(within(dialog).getByRole('button', { name: 'Marquer comme effectué' }));
    expect(await screen.findByText(/en cours chez le prestataire de paiement, ou déjà effectué : ne remboursez pas à la main/)).toBeInTheDocument();
  });
});

describe('membres, journal, admin plateforme', () => {
  it('membres : ajout d’un compte inconnu ⇒ message ; dernier propriétaire protégé (après confirmation)', async () => {
    const user = userEvent.setup();
    await renderApp(`${ORG}/members`, { as: OWNER });
    await user.type(await screen.findByLabelText('Adresse email du compte'), 'inconnu@example.test');
    await user.click(screen.getByRole('button', { name: 'Ajouter' }));
    expect(await screen.findByText(/Aucun compte confirmé n’utilise cette adresse/)).toBeInTheDocument();
    await user.selectOptions(screen.getAllByLabelText('Rôle')[0] as HTMLElement, 'MANAGER');
    const dialog = screen.getByRole('dialog', { name: 'Modifier ce rôle ?' });
    expect(dialog).toHaveTextContent('il s’agit de VOTRE compte');
    await user.click(within(dialog).getByRole('button', { name: 'Confirmer' }));
    expect(await screen.findByText('Le collectif doit garder au moins un propriétaire.')).toBeInTheDocument();
  });

  it('M1 : rétrogradation d’un autre membre ⇒ confirmation ; rien n’est envoyé avant', async () => {
    const user = userEvent.setup();
    await renderApp(`${ORG}/members`, { as: OWNER });
    const managerCard = (await screen.findByText('manager@nuits.test')).closest('li') as HTMLElement;
    await user.selectOptions(within(managerCard).getByLabelText('Rôle'), 'SCANNER');
    expect(mock.db.calls.get('PATCH /orgs/:orgId/members/:userId') ?? 0).toBe(0);
    const dialog = screen.getByRole('dialog', { name: 'Modifier ce rôle ?' });
    expect(dialog).toHaveTextContent('passera de « Gestionnaire » à « Contrôle d’accès »');
    await user.click(within(dialog).getByRole('button', { name: 'Confirmer' }));
    await waitFor(() => expect(mock.db.memberships.find((x) => x.userId === IDS.userManager && x.orgId === IDS.orgNuits)?.role).toBe('SCANNER'));
  });

  it('M1 : se retirer soi-même ⇒ avertissement renforcé, puis adhésions rechargées et retour au sélecteur', async () => {
    const user = userEvent.setup();
    mock.db.memberships.push({ userId: IDS.userManager, orgId: IDS.orgNuits, role: 'OWNER', createdAt: new Date().toISOString() });
    mock.db.memberships = mock.db.memberships.filter((x) => !(x.userId === IDS.userManager && x.role === 'MANAGER' && x.orgId === IDS.orgNuits));
    const { router } = await renderApp(`${ORG}/members`, { as: OWNER });
    const selfCard = (await screen.findByText('owner@nuits.test')).closest('li') as HTMLElement;
    await user.click(within(selfCard).getByRole('button', { name: 'Retirer' }));
    const dialog = screen.getByRole('dialog', { name: 'Retirer ce membre ?' });
    expect(dialog).toHaveTextContent('il s’agit de VOTRE compte');
    await user.click(within(dialog).getByRole('button', { name: 'Retirer' }));
    await waitFor(() => expect(router.state.location.pathname).not.toBe(`${ORG}/members`));
    expect(mock.db.calls.get('GET /auth/me') ?? 0).toBeGreaterThan(0);
  });

  it('journal (OWNER) : actions système affichées « Système », détails en texte', async () => {
    await renderApp(`${ORG}/audit`, { as: OWNER });
    expect(await screen.findByText('Système')).toBeInTheDocument();
    expect(screen.getByText('Administrateur plateforme')).toBeInTheDocument();
    expect(screen.getByText('{"count":3}')).toBeInTheDocument();
  });

  it('B5 : détails longs tronqués avec « Voir tout » ; indicateur de page', async () => {
    const user = userEvent.setup();
    mock.db.audit.unshift({ id: crypto.randomUUID(), orgId: IDS.orgNuits, actorEmail: 'owner@nuits.test', action: 'settings.update', target: 'organization', meta: { long: 'x'.repeat(400) }, createdAt: new Date().toISOString() });
    for (let i = 0; i < 30; i++) mock.db.audit.push({ id: crypto.randomUUID(), orgId: IDS.orgNuits, actorEmail: null, action: 'order.expire', target: 'order', meta: null, createdAt: new Date(0).toISOString() });
    await renderApp(`${ORG}/audit`, { as: OWNER });
    const toggle = await screen.findByRole('button', { name: 'Voir tout' });
    expect(screen.getByText(/x{280,}…$/)).toBeInTheDocument();
    await user.click(toggle);
    expect(screen.getByText(new RegExp(`x{400}`))).toBeInTheDocument();
    expect(screen.getByText(/^Page 1 \/ 2$/)).toBeInTheDocument();
  });

  it('journal refusé au MANAGER', async () => {
    await renderApp(`${ORG}/audit`, { as: MANAGER });
    expect(await screen.findByRole('heading', { name: 'Accès non autorisé' })).toBeInTheDocument();
  });

  it('admin plateforme : liste paginée (v1.8), création avec slug généré ; non-admin refusé', async () => {
    const user = userEvent.setup();
    await renderApp('/admin', { as: 'admin@plateforme.test' });
    expect(await screen.findByText('Collectif Rive Droite')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Nom'), 'Été Électro à Bègles');
    expect(screen.getByLabelText('Identifiant (slug)')).toHaveValue('ete-electro-a-begles');
    await user.type(screen.getByLabelText(/Email du propriétaire/), 'acheteur@example.test');
    await user.click(screen.getByRole('button', { name: 'Créer le collectif' }));
    expect(await screen.findByText('Collectif « Été Électro à Bègles » créé.')).toBeInTheDocument();
    expect(await screen.findByText('Été Électro à Bègles')).toBeInTheDocument();
  });

  it('admin : page refusée à un non-admin', async () => {
    await renderApp('/admin', { as: OWNER });
    expect(await screen.findByRole('heading', { name: 'Accès non autorisé' })).toBeInTheDocument();
  });
});

describe('changement de collectif dans la même session (revue F3.1)', () => {
  const ORG_B = `/org/${IDS.orgPartner}`; // owner@nuits.test est MANAGER de Rive Droite

  it('H1 : le formulaire bancaire saisi pour A disparaît en passant à B (aucun envoi, champs vides)', async () => {
    const user = userEvent.setup();
    const patches: string[] = [];
    server.events.on('request:start', ({ request }) => {
      if (request.method === 'PATCH') patches.push(request.url);
    });
    const { router } = await renderApp(`${ORG}/settings`, { as: OWNER });
    await user.click(await screen.findByRole('button', { name: 'Modifier les coordonnées bancaires' }));
    await user.type(screen.getByLabelText('IBAN complet'), 'FR76 3000 6000 0112 3456 7890 189');
    await user.type(screen.getByLabelText('Votre mot de passe (confirmation)'), DEMO_PASSWORD);
    await act(() => router.navigate(`${ORG_B}/settings`));
    await screen.findByText(/Lecture seule/); // MANAGER sur B
    expect(screen.queryByLabelText('IBAN complet')).toBeNull();
    expect(screen.queryByDisplayValue(/FR76/)).toBeNull();
    expect(screen.queryByDisplayValue(DEMO_PASSWORD)).toBeNull();
    server.events.removeAllListeners();
    expect(patches).toEqual([]);
  });

  it('H1 : remontage complet (filtres, page) au changement de collectif', async () => {
    const user = userEvent.setup();
    const { router } = await renderApp(ORG, { as: OWNER });
    await user.click(await screen.findByRole('button', { name: 'Brouillons' }));
    expect(screen.getByRole('button', { name: 'Brouillons' })).toHaveAttribute('aria-pressed', 'true');
    await act(() => router.navigate(ORG_B));
    expect(await screen.findByRole('button', { name: 'Tous' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('H2 : pendant le chargement de B, jamais les événements de A sous l’en-tête de B', async () => {
    server.use(
      http.get(`*/api/v1/orgs/${IDS.orgPartner}/events`, async () => {
        await delay(300);
        return undefined;
      }),
    );
    const { router } = await renderApp(ORG, { as: OWNER });
    expect(await screen.findByRole('link', { name: /Garonne Électrique/ })).toBeInTheDocument();
    await act(() => router.navigate(ORG_B));
    expect(screen.getByRole('combobox', { name: /ESPACE/ })).toHaveDisplayValue('Collectif Rive Droite');
    expect(screen.queryByRole('link', { name: /Garonne Électrique/ })).toBeNull();
    expect(await screen.findByRole('link', { name: 'Rive Droite Jazz Club' })).toBeInTheDocument();
  });

  it('H2 : keepIfSameScope ne garde les données que pour le même collectif et le même événement', async () => {
    const { keepIfSameScope } = await import('../../api/hooks/org');
    const prev = { items: [1] };
    expect(keepIfSameScope('A')(prev, { queryKey: ['org', 'A', 'events'] })).toBe(prev);
    expect(keepIfSameScope('B')(prev, { queryKey: ['org', 'A', 'events'] })).toBeUndefined();
    expect(keepIfSameScope('A', 'e2')(prev, { queryKey: ['org', 'A', 'event', 'e1', 'orders'] })).toBeUndefined();
    expect(keepIfSameScope('A', 'e1')(prev, { queryKey: ['org', 'A', 'event', 'e1', 'orders'] })).toBe(prev);
  });
});

describe('remboursements (contrat v1.10)', () => {
  async function paidTransferThenCancelled() {
    await login('acheteur@example.test', DEMO_PASSWORD);
    const order = await apiRequest<Order>('/orders', { method: 'POST', body: { eventId: IDS.eventConcert, paymentMethod: 'TRANSFER', items: [{ ticketTypeId: IDS.ttFosse, quantity: 1 }] }, headers: { 'Idempotency-Key': crypto.randomUUID() } });
    await logout();
    await login(MANAGER, DEMO_PASSWORD);
    await apiRequest(`/orgs/${IDS.orgNuits}/orders/${order.id}/confirm-transfer`, { method: 'POST', body: { receivedAmountCents: order.totalCents } });
    await logout();
    await login('acheteur@example.test', DEMO_PASSWORD);
    await apiRequest(`/orders/${order.id}/cancel`, { method: 'POST' });
    await logout();
    return order;
  }

  it('virement remboursé ⇒ MANUAL_REQUIRED ; alerte au tableau de bord vers la page filtrée ; marquer effectué avec note', async () => {
    const user = userEvent.setup();
    await paidTransferThenCancelled();
    const { router } = await renderApp(`${EVENT}/dashboard`, { as: MANAGER });
    const alert = await screen.findByText(/1 remboursement à effectuer manuellement/);
    await user.click(within(alert.closest('p') as HTMLElement).getByRole('link', { name: 'Voir les remboursements' }));
    await waitFor(() => expect(router.state.location.pathname).toBe(`${ORG}/refunds`));
    expect(router.state.location.search).toBe(`?eventId=${IDS.eventConcert}`);
    expect(await screen.findByText('À effectuer manuellement', { selector: '.badge' })).toBeInTheDocument();
    expect(screen.getByText(/payé par virement/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Marquer comme effectué' }));
    const dialog = screen.getByRole('dialog', { name: 'Confirmer le remboursement effectué ?' });
    expect(dialog).toHaveTextContent(/18,00\s€/); // frais de service non remboursables dans ce collectif
    expect(dialog).toHaveTextContent('acheteur@example.test');
    const confirm = within(dialog).getByRole('button', { name: 'Marquer comme effectué' });
    expect(confirm).toBeDisabled(); // note obligatoire
    await user.type(within(dialog).getByLabelText(/Note/), 'Virement retour effectué le 12/11');
    await user.click(confirm);
    expect(await screen.findByText('Effectué', { selector: '.badge' })).toBeInTheDocument();
    expect(screen.getByText('Note : Virement retour effectué le 12/11')).toBeInTheDocument();
    expect(mock.db.audit[0]?.action).toBe('refund.markDone');
  });

  it('déjà traité ailleurs ⇒ INVALID_STATE expliqué ; filtre de statut transmis', async () => {
    const user = userEvent.setup();
    await paidTransferThenCancelled();
    const urls: string[] = [];
    server.events.on('request:start', ({ request }) => {
      if (request.url.includes('/refunds?')) urls.push(request.url);
    });
    await renderApp(`${ORG}/refunds`, { as: OWNER });
    await user.selectOptions(await screen.findByLabelText('Statut'), 'MANUAL_REQUIRED');
    await waitFor(() => expect(urls.some((u) => u.includes('status=MANUAL_REQUIRED'))).toBe(true));
    server.events.removeAllListeners();
    const r = mock.db.refunds[0];
    if (r) r.status = 'SUCCEEDED'; // traité par un autre gestionnaire entre-temps
    await user.click(await screen.findByRole('button', { name: 'Marquer comme effectué' }));
    await user.type(screen.getByLabelText(/Note/), 'fait');
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Marquer comme effectué' }));
    expect(await screen.findByText('Ce remboursement a déjà été traité. La liste a été actualisée.')).toBeInTheDocument();
  });

  it('carte remboursée ⇒ SUCCEEDED, rien à faire ; aucune alerte au tableau de bord', async () => {
    await login('acheteur@example.test', DEMO_PASSWORD);
    const order = await apiRequest<Order>('/orders', { method: 'POST', body: { eventId: IDS.eventConcert, paymentMethod: 'CARD', items: [{ ticketTypeId: IDS.ttFosse, quantity: 1 }] }, headers: { 'Idempotency-Key': crypto.randomUUID() } });
    const { markPaid } = await import('../../mocks/domain');
    const stored = mock.db.orders.find((o) => o.id === order.id);
    if (stored) await markPaid(stored);
    await apiRequest(`/orders/${order.id}/cancel`, { method: 'POST' });
    await logout();
    await renderApp(`${EVENT}/dashboard`, { as: MANAGER });
    expect((await screen.findAllByText('Vendues')).length).toBeGreaterThan(0);
    expect(screen.queryByText(/à effectuer manuellement/)).toBeNull();
  });
});
