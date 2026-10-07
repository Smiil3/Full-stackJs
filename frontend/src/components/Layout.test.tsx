import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { IDS } from '../mocks/state';
import { BUYER, openMenu, renderApp } from '../test/renderApp';

const theme = () => document.documentElement.dataset.theme;

describe('Layout « Miroir d’eau » (D1)', () => {
  afterEach(() => {
    localStorage.clear();
  });

  it('menu burger : ouverture (focus sur le 1er lien), Échap le ferme et rend le focus au bouton', async () => {
    const user = userEvent.setup();
    await renderApp('/', { as: BUYER });
    const burger = await screen.findByRole('button', { name: 'Ouvrir le menu' });
    expect(burger).toHaveAttribute('aria-expanded', 'false');
    await user.click(burger);
    expect(screen.getByRole('button', { name: 'Fermer le menu' })).toHaveAttribute('aria-expanded', 'true');
    const nav = screen.getByRole('navigation', { name: 'Navigation principale' });
    await waitFor(() => expect(document.activeElement).toBe(nav.querySelector('a')));
    expect(screen.getByRole('link', { name: 'Commandes' })).toBeVisible();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('navigation', { name: 'Navigation principale' })).toBeNull(); // panneau masqué
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Ouvrir le menu' }));
  });

  it('changement de page ⇒ menu refermé', async () => {
    const user = userEvent.setup();
    const { router } = await renderApp('/', { as: BUYER });
    await openMenu(user);
    await user.click(screen.getByRole('link', { name: 'Commandes' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/me/orders'));
    expect(screen.getByRole('button', { name: 'Ouvrir le menu' })).toHaveAttribute('aria-expanded', 'false');
  });

  it('thème : Nuit sur le site public, Jour au paiement et au back-office, préférence mémorisée, scanner toujours sombre', async () => {
    const user = userEvent.setup();
    const { router } = await renderApp('/', { as: 'owner@nuits.test' });
    await screen.findByRole('button', { name: 'Ouvrir le menu' });
    expect(theme()).toBe('dark');
    await act(() => router.navigate(`/org/${IDS.orgNuits}`));
    expect(theme()).toBe('light');
    await act(() => router.navigate('/'));
    expect(theme()).toBe('dark');
    await openMenu(user);
    await user.click(screen.getByRole('button', { name: 'Mode clair' }));
    expect(theme()).toBe('light');
    expect(localStorage.getItem('ndg-theme')).toBe('light');
    await act(() => router.navigate('/scan'));
    expect(theme()).toBe('dark'); // le scanner ignore la préférence
  });

  it('pied de page : réassurance et espace organisateurs', async () => {
    await renderApp('/');
    const footer = await screen.findByRole('contentinfo');
    expect(footer).toHaveTextContent('Carte bancaire ou virement');
    expect(footer).toHaveTextContent('Billets consultables même sans réseau');
    expect(screen.getByRole('link', { name: 'Espace organisateurs' })).toHaveAttribute('href', '/org');
  });
});
