import { QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { describe, expect, it } from 'vitest';
import { createQueryClient } from '../api/queryClient';
import { mock } from '../mocks/core';
import { DEMO_PASSWORD } from '../mocks/state';
import { useAuth } from './AuthContext';
import { AuthProvider } from './AuthProvider';
import { registerSessionCleanup } from './sessionCleanup';

function Capture({ onAuth }: { onAuth: (a: ReturnType<typeof useAuth>) => void }) {
  const auth = useAuth();
  useEffect(() => {
    onAuth(auth);
  });
  return null;
}

function Probe() {
  const { status, user } = useAuth();
  return <p>{`${status}:${user?.email ?? '-'}`}</p>;
}

function setup() {
  const qc = createQueryClient();
  const holder: { auth?: ReturnType<typeof useAuth> } = {};
  const keep = (a: ReturnType<typeof useAuth>) => {
    holder.auth = a;
  };
  render(
    <QueryClientProvider client={qc}>
      <AuthProvider>
        <Probe />
        <Capture onAuth={keep} />
      </AuthProvider>
    </QueryClientProvider>,
  );
  return { qc, auth: () => holder.auth as ReturnType<typeof useAuth> };
}

describe('AuthProvider', () => {
  it('sans cookie de refresh au chargement ⇒ anonyme', async () => {
    setup();
    expect(await screen.findByText('anonymous:-')).toBeInTheDocument();
  });

  it('démarrage anonyme : les requêtes publiques en cours ne sont pas annulées', async () => {
    const { qc } = setup();
    const pending = qc.query({ queryKey: ['public'], queryFn: () => new Promise((r) => setTimeout(() => r('ok'), 30)) });
    await screen.findByText('anonymous:-');
    await expect(pending).resolves.toBe('ok');
    expect(qc.getQueryData(['public'])).toBe('ok');
  });

  it('restaure la session au chargement via le cookie de refresh', async () => {
    mock.db.refreshCookie = { token: 'x', userId: mock.db.users[0]?.id ?? '' };
    setup();
    expect(await screen.findByText('authenticated:acheteur@example.test')).toBeInTheDocument();
  });

  it('réseau indisponible au chargement ⇒ statut hors-ligne (pas de déconnexion)', async () => {
    const { injectFault } = await import('../mocks/core');
    injectFault({ route: 'POST /auth/refresh', status: 0, code: 'INTERNAL_ERROR', network: true });
    setup();
    expect(await screen.findByText('offline:-')).toBeInTheDocument();
  });

  it('logout ⇒ cache TanStack Query vidé et nettoyages hors-ligne exécutés', async () => {
    const { qc, auth } = setup();
    await screen.findByText('anonymous:-');
    await act(() => auth().login('owner@nuits.test', DEMO_PASSWORD));
    qc.setQueryData(['orgs', 'secret'], { iban: 'FR76…' });
    let cleaned = 0;
    registerSessionCleanup(() => {
      cleaned++;
    });
    await act(() => auth().logout());
    await waitFor(() => {
      expect(qc.getQueryCache().getAll()).toHaveLength(0);
    });
    expect(cleaned).toBe(1);
    expect(screen.getByText('anonymous:-')).toBeInTheDocument();
  });

  it('changement de compte ⇒ cache vidé', async () => {
    const { qc, auth } = setup();
    await screen.findByText('anonymous:-');
    await act(() => auth().login('owner@nuits.test', DEMO_PASSWORD));
    qc.setQueryData(['orgs', 'secret'], { x: 1 });
    qc.getMutationCache().build(qc, { mutationFn: () => new Promise(() => undefined) });
    let seenStaleData = false;
    const off = qc.getQueryCache().subscribe(() => undefined);
    // Revue F1.1 (B4) : au moment où le NOUVEL utilisateur est publié, le cache est déjà vide.
    const { onAuthEvent } = await import('../api/client');
    const unsubscribe = onAuthEvent((e) => {
      if (e.type === 'session' && e.session.user.email === 'acheteur@example.test') {
        queueMicrotask(() => {
          if (qc.getQueryData(['orgs', 'secret']) !== undefined) seenStaleData = true;
        });
      }
    });
    await act(() => auth().login('acheteur@example.test', DEMO_PASSWORD));
    unsubscribe();
    off();
    expect(qc.getQueryData(['orgs', 'secret'])).toBeUndefined();
    expect(qc.getMutationCache().getAll()).toHaveLength(0);
    expect(seenStaleData).toBe(false);
    expect(screen.getByText('authenticated:acheteur@example.test')).toBeInTheDocument();
  });
});
