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
