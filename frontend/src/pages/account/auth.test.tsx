import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { logout } from '../../api/client';
import { getAccessToken } from '../../auth/tokenStore';
import { injectFault, mock } from '../../mocks/core';
import { mockOutbox } from '../../mocks/handlers/auth';
import { DEMO_PASSWORD } from '../../mocks/state';
import { BUYER, renderApp } from '../../test/renderApp';

async function fillLogin(user: ReturnType<typeof userEvent.setup>, email: string, password: string) {
  await user.type(await screen.findByLabelText('Adresse email'), email);
  await user.type(screen.getByLabelText('Mot de passe'), password);
  await user.click(screen.getByRole('button', { name: 'Se connecter' }));
}

describe('connexion', () => {
  it('succès ⇒ redirection vers ?next interne', async () => {
    const user = userEvent.setup();
    const { router } = await renderApp(`/login?next=${encodeURIComponent('/me/orders')}`);
    await fillLogin(user, BUYER, DEMO_PASSWORD);
    await waitFor(() => expect(router.state.location.pathname).toBe('/me/orders'));
  });

  it('?next externe ou détourné ⇒ redirection vers l’accueil', async () => {
    const user = userEvent.setup();
    const { router } = await renderApp(`/login?next=${encodeURIComponent('/.//evil.com')}`);
    await fillLogin(user, BUYER, DEMO_PASSWORD);
    await waitFor(() => expect(router.state.location.pathname).toBe('/'));
  });

  it.each(['constructor', '__proto__', 'toString'])('M6 : ?info=%s ⇒ aucun message, pas de plantage', async (info) => {
    await renderApp(`/login?info=${info}`);
    expect(await screen.findByRole('heading', { name: 'Connexion' })).toBeInTheDocument();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('identifiants invalides ⇒ message générique, mot de passe effacé', async () => {
    const user = userEvent.setup();
    await renderApp('/login');
    await fillLogin(user, BUYER, 'mauvais-mot-de-passe');
    expect(await screen.findByRole('alert')).toHaveTextContent('Adresse email ou mot de passe incorrect.');
    expect(screen.getByLabelText('Mot de passe')).toHaveValue('');
  });

  it('email non vérifié (v1.5) ⇒ écran « Vérifiez votre email » + renvoi du lien', async () => {
    const user = userEvent.setup();
    await renderApp('/login');
    await fillLogin(user, 'nonverifie@example.test', DEMO_PASSWORD);
    expect(await screen.findByRole('heading', { name: 'Vérifiez votre email' })).toBeInTheDocument();
    expect(getAccessToken()).toBeNull();
    const before = mockOutbox.length;
    await user.click(screen.getByRole('button', { name: 'Renvoyer le lien' }));
    expect(await screen.findByRole('button', { name: /Lien renvoyé/ })).toBeDisabled();
    expect(mockOutbox.length).toBe(before + 1);
  });

  it('trop de tentatives ⇒ délai indiqué', async () => {
    const user = userEvent.setup();
    await renderApp('/login');
    injectFault({ route: 'POST /auth/login', status: 429, code: 'RATE_LIMITED', headers: { 'Retry-After': '60' } });
    await fillLogin(user, BUYER, DEMO_PASSWORD);
    expect(await screen.findByRole('alert')).toHaveTextContent('Réessayez dans 60 secondes');
  });
});

describe('inscription', () => {
  it('mot de passe courant refusé par le serveur ⇒ message sur le champ', async () => {
    const user = userEvent.setup();
    await renderApp('/register');
    await user.type(await screen.findByLabelText('Adresse email'), 'nouvelle@example.test');
    await user.type(screen.getByLabelText('Nom affiché'), 'Nouvelle');
    await user.type(screen.getByLabelText('Mot de passe'), 'motdepasse123');
    await user.type(screen.getByLabelText('Confirmer le mot de passe'), 'motdepasse123');
    await user.click(screen.getByRole('button', { name: 'Créer mon compte' }));
    expect(await screen.findByText(/pas un mot de passe courant/)).toBeInTheDocument();
  });

  it('contrôles UX : email accentué, mots de passe différents', async () => {
    const user = userEvent.setup();
    await renderApp('/register');
    await user.type(await screen.findByLabelText('Adresse email'), 'josé@example.fr');
    await user.type(screen.getByLabelText('Nom affiché'), 'José');
    await user.type(screen.getByLabelText('Mot de passe'), 'une-phrase-de-passe');
    await user.type(screen.getByLabelText('Confirmer le mot de passe'), 'une-autre-phrase');
    await user.click(screen.getByRole('button', { name: 'Créer mon compte' }));
    expect(screen.getByText(/caractères accentués ne sont pas acceptés/)).toBeInTheDocument();
    expect(screen.getByText('Les deux mots de passe ne correspondent pas.')).toBeInTheDocument();
    expect(mock.db.calls.get('POST /auth/register') ?? 0).toBe(0);
  });

  it('D1 : champs vides ⇒ messages humains (§ 7), rien n’est envoyé', async () => {
    const user = userEvent.setup();
    await renderApp('/register');
    await user.click(await screen.findByRole('button', { name: 'Créer mon compte' }));
    expect(screen.getByText('Il manque votre e-mail : c’est là que nous envoyons les billets.')).toBeInTheDocument();
    expect(screen.getByText('Il manque votre nom.')).toBeInTheDocument();
    expect(mock.db.calls.get('POST /auth/register') ?? 0).toBe(0);
  });

  it('succès ⇒ message neutre identique, que le compte existe ou non', async () => {
    const user = userEvent.setup();
    await renderApp('/register');
    await user.type(await screen.findByLabelText('Adresse email'), BUYER);
    await user.type(screen.getByLabelText('Nom affiché'), 'X');
    await user.type(screen.getByLabelText('Mot de passe'), 'une-phrase-de-passe');
    await user.type(screen.getByLabelText('Confirmer le mot de passe'), 'une-phrase-de-passe');
    await user.click(screen.getByRole('button', { name: 'Créer mon compte' }));
    expect(await screen.findByText(/Si cette adresse peut être utilisée/)).toBeInTheDocument();
  });
});

describe('vérification email et réinitialisation', () => {
  it('lien de vérification : jeton retiré de l’URL, confirmation par bouton, puis connexion (v1.5)', async () => {
    const user = userEvent.setup();
    const token = crypto.randomUUID();
    mock.db.verifyTokens.set(token, 'aaaaaaaa-0000-4000-8000-000000000006');
    const { router } = await renderApp(`/verify-email?token=${token}`);
    await screen.findByRole('button', { name: 'Confirmer mon adresse' });
    await waitFor(() => expect(router.state.location.search).toBe(''));
    expect(mock.db.calls.get('POST /auth/verify-email') ?? 0).toBe(0); // rien d'automatique
    await user.click(screen.getByRole('button', { name: 'Confirmer mon adresse' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/login'));
    expect(await screen.findByText(/Votre adresse email est confirmée/)).toBeInTheDocument();
  });

  it('M7 : jeton retiré de l’URL sans être perdu au remontage du composant', async () => {
    const user = userEvent.setup();
    const token = crypto.randomUUID();
    mock.db.verifyTokens.set(token, 'aaaaaaaa-0000-4000-8000-000000000006');
    const first = await renderApp(`/verify-email?token=${token}`);
    await waitFor(() => expect(first.router.state.location.search).toBe(''));
    first.unmount();
    const { router } = await renderApp('/verify-email'); // remontage : l'URL ne contient plus le jeton
    await user.click(await screen.findByRole('button', { name: 'Confirmer mon adresse' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/login'));
  });

  it('F6-B6 : fin de session ⇒ le jeton retiré de l’URL est oublié', async () => {
    const token = crypto.randomUUID();
    mock.db.verifyTokens.set(token, 'aaaaaaaa-0000-4000-8000-000000000006');
    const first = await renderApp(`/verify-email?token=${token}`, { as: BUYER });
    await waitFor(() => expect(first.router.state.location.search).toBe(''));
    first.unmount();
    await logout(); // fin de session sur cet appareil
    await renderApp('/verify-email');
    expect(await screen.findByRole('heading', { name: 'Confirmer mon adresse email' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Confirmer mon adresse' })).toBeNull();
  });

  it('lien invalide ⇒ proposition de renvoi', async () => {
    const user = userEvent.setup();
    await renderApp('/verify-email?token=faux');
    await user.click(await screen.findByRole('button', { name: 'Confirmer mon adresse' }));
    expect(await screen.findByText(/Ce lien est invalide ou a expiré/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Recevoir un nouveau lien' })).toBeInTheDocument();
  });

  it('mot de passe oublié ⇒ message neutre', async () => {
    const user = userEvent.setup();
    await renderApp('/forgot-password');
    await user.type(await screen.findByLabelText('Adresse email'), 'inconnu@example.test');
    await user.click(screen.getByRole('button', { name: 'Recevoir un lien' }));
    expect(await screen.findByText(/Si un compte correspond à cette adresse/)).toBeInTheDocument();
  });

  it('réinitialisation ⇒ connexion avec message de succès', async () => {
    const user = userEvent.setup();
    const token = crypto.randomUUID();
    mock.db.resetTokens.set(token, 'aaaaaaaa-0000-4000-8000-000000000001');
    const { router } = await renderApp(`/reset-password?token=${token}`);
    await user.type(await screen.findByLabelText('Nouveau mot de passe'), 'nouvelle-phrase-de-passe');
    await user.type(screen.getByLabelText('Confirmer'), 'nouvelle-phrase-de-passe');
    await user.click(screen.getByRole('button', { name: 'Enregistrer' }));
    await waitFor(() => expect(router.state.location.search).toBe('?info=reset'));
  });

  it('changement de mot de passe : mauvais mot de passe actuel ⇒ erreur dans le formulaire sans déconnexion ; succès ⇒ reconnexion', async () => {
    const user = userEvent.setup();
    const { router } = await renderApp('/account', { as: BUYER });
    await user.type(await screen.findByLabelText('Mot de passe actuel'), 'faux');
    await user.type(screen.getByLabelText('Nouveau mot de passe'), 'nouvelle-phrase-de-passe');
    await user.type(screen.getByLabelText('Confirmer le nouveau mot de passe'), 'nouvelle-phrase-de-passe');
    await user.click(screen.getByRole('button', { name: 'Changer le mot de passe' }));
    expect(await screen.findByText('Mot de passe actuel incorrect.')).toBeInTheDocument();
    expect(getAccessToken()).not.toBeNull();
    await user.type(screen.getByLabelText('Mot de passe actuel'), DEMO_PASSWORD);
    await user.click(screen.getByRole('button', { name: 'Changer le mot de passe' }));
    await waitFor(() => expect(router.state.location.search).toBe('?info=changed'));
    expect(getAccessToken()).toBeNull();
  });
});
