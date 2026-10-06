import { createContext, useContext } from 'react';
import type { User } from '../api/types';

export type AuthStatus = 'loading' | 'authenticated' | 'anonymous' | 'offline';

export type AuthContextValue = {
  status: AuthStatus;
  user: User | null;
  login: (email: string, password: string) => Promise<User>;
  logout: () => Promise<void>;
  /** Recharge l'utilisateur (adhésions, email vérifié…) via GET /auth/me. */
  reloadUser: () => Promise<void>;
  /**
   * Destination (chemin interne) à utiliser si la session se termine pendant une action qui la
   * révoque volontairement (changement de mot de passe) — au lieu de « /login?next=… ».
   */
  sessionEndRedirect: string | null;
  setSessionEndRedirect: (path: string | null) => void;
};

export const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth doit être utilisé dans <AuthProvider>');
  return ctx;
}
