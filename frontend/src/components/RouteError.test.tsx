import { render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { AppErrorBoundary } from './AppErrorBoundary';
import { RouteError } from './RouteError';

function Boom(): never {
  throw new Error('détail technique secret');
}

describe('erreurs globales (revue F1.1 — B1)', () => {
  it('une route qui plante affiche un message neutre, sans détail technique', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const router = createMemoryRouter([{ path: '/', element: <Boom />, errorElement: <RouteError /> }]);
    render(<RouterProvider router={router} />);
    expect(screen.getByRole('heading', { name: 'Un problème est survenu' })).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('détail technique secret');
  });

  it('une erreur hors routeur est rattrapée par AppErrorBoundary', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(
      <AppErrorBoundary>
        <Boom />
      </AppErrorBoundary>,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Un problème est survenu');
    expect(document.body.textContent).not.toContain('détail technique secret');
  });
});
