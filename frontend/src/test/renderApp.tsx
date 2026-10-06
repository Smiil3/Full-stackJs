import { QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { login } from '../api/client';
import { createQueryClient } from '../api/queryClient';
import { AuthProvider } from '../auth/AuthProvider';
import { DEMO_PASSWORD } from '../mocks/state';
import { routes } from '../router';

/**
 * Rend l'application complète (vraies routes, vrai client API, MSW) sur une URL donnée.
 * `as` : connecte d'abord ce compte (le cookie de refresh simulé restaure la session au montage).
 */
export async function renderApp(url: string, opts: { as?: string } = {}) {
  if (opts.as) await login(opts.as, DEMO_PASSWORD);
  const queryClient = createQueryClient();
  queryClient.setDefaultOptions({ queries: { ...queryClient.getDefaultOptions().queries, retry: false } });
  const router = createMemoryRouter(routes, { initialEntries: [url] });
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <RouterProvider router={router} />
      </AuthProvider>
    </QueryClientProvider>,
  );
  return { ...utils, router, queryClient };
}

export const BUYER = 'acheteur@example.test';

/** Contrat v1.15 : place les événements de contrôle du mock dans la fenêtre (début dans 1 h). */
export async function openCheckinWindow(...eventIds: string[]): Promise<void> {
  const { mock } = await import('../mocks/core');
  for (const id of eventIds) {
    const e = mock.db.events.find((x) => x.id === id);
    if (!e) continue;
    e.startsAt = new Date(Date.now() + 3_600_000).toISOString();
    e.endsAt = new Date(Date.now() + 5 * 3_600_000).toISOString();
    e.salesEndAt = e.startsAt; // invariant : fin des ventes ≤ fin de l'événement
  }
}

/** Ouvre le menu du site (burger) : la navigation secondaire et la déconnexion y sont rangées. */
export async function openMenu(user: { click: (el: Element) => Promise<void> }) {
  const { screen } = await import('@testing-library/react');
  await user.click(screen.getByRole('button', { name: 'Ouvrir le menu' }));
}

/** Déconnexion terminée : le menu propose de nouveau « Se connecter ». */
export async function expectLoggedOut() {
  const { screen } = await import('@testing-library/react');
  await screen.findByText(/Se connecter/, { selector: 'a' });
}
