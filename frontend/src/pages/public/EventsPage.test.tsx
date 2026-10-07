import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { IDS } from '../../mocks/state';
import { renderApp } from '../../test/renderApp';

describe('catalogue « Miroir d’eau » (D1)', () => {
  it('toute la carte est un lien nommé par le titre ; prix rond sans décimales', async () => {
    await renderApp('/');
    const card = await screen.findByRole('link', { name: 'Garonne Électrique — soirée d’ouverture' });
    expect(card).toHaveAttribute('href', `/events/${IDS.eventConcert}`);
    expect(within(card).getByText('Le Rocher de Palmer')).toBeInTheDocument();
    expect(within(card).getByText(/à partir de/)).toHaveTextContent(/18\s€/);
  });

  it('filtre « En ligne », recherche, état vide et retour à tous les événements', async () => {
    const user = userEvent.setup();
    await renderApp('/');
    await screen.findByRole('link', { name: /Garonne Électrique/ });
    await user.click(screen.getByRole('button', { name: 'En ligne' }));
    expect(screen.getByRole('button', { name: 'En ligne' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('link', { name: 'Session acoustique en ligne' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Garonne Électrique/ })).toBeNull();
    await user.type(screen.getByRole('searchbox', { name: 'Rechercher un événement' }), 'introuvable');
    expect(screen.getByText('Rien de prévu avec ce filtre pour l’instant')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Voir tous les événements' }));
    expect(await screen.findByRole('link', { name: /Garonne Électrique/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Tout' })).toHaveAttribute('aria-pressed', 'true');
  });
});
