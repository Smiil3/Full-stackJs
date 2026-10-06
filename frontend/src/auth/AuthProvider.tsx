import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { apiRequest, login as apiLogin, logout as apiLogout, onAuthEvent, refreshSession } from '../api/client';
import { isApiError } from '../api/errors';
import type { User } from '../api/types';
import { AuthContext, type AuthContextValue, type AuthStatus } from './AuthContext';
import { runSessionCleanups } from './sessionCleanup';

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [user, setUser] = useState<User | null>(null);
  const userIdRef = useRef<string | null>(null);

  /** Fin de session : AUCUNE donnée d'un compte ne doit survivre (cache Query, hors-ligne). */
  const wipe = useCallback(async () => {
    await queryClient.cancelQueries();
    queryClient.clear();
    await runSessionCleanups();
  }, [queryClient]);

  useEffect(() => {
    const off = onAuthEvent((e) => {
      if (e.type === 'session') {
        const previous = userIdRef.current;
        if (previous !== null && previous !== e.session.user.id) void wipe(); // changement de compte
        userIdRef.current = e.session.user.id;
        setUser(e.session.user);
        setStatus('authenticated');
      } else {
        userIdRef.current = null;
        setUser(null);
        setStatus('anonymous');
        void wipe();
      }
    });
    // Restauration de session au chargement via le cookie HttpOnly (promesse partagée côté client).
    refreshSession().catch((err: unknown) => {
      if (isApiError(err) && (err.code === 'NETWORK_ERROR' || err.code === 'TIMEOUT' || err.status >= 500)) {
        setStatus((s) => (s === 'loading' ? 'offline' : s));
      } else {
        setStatus((s) => (s === 'loading' ? 'anonymous' : s));
      }
    });
    return off;
  }, [wipe]);

  const login = useCallback(async (email: string, password: string) => (await apiLogin(email, password)).user, []);
  const logout = useCallback(() => apiLogout(), []);
  const reloadUser = useCallback(async () => {
    const me = await apiRequest<User>('/auth/me');
    userIdRef.current = me.id;
    setUser(me);
  }, []);

  const value = useMemo<AuthContextValue>(() => ({ status, user, login, logout, reloadUser }), [status, user, login, logout, reloadUser]);
  return <AuthContext value={value}>{children}</AuthContext>;
}
