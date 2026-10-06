import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { apiRequest, completePendingLogout, login as apiLogin, logout as apiLogout, onAuthEvent, refreshSession } from '../api/client';
import { isLogoutPending } from '../offline/pendingLogout';
import { isApiError } from '../api/errors';
import { parseUser } from '../api/guards';
import type { User } from '../api/types';
import { AuthContext, type AuthContextValue, type AuthNotice, type AuthStatus } from './AuthContext';
import { runSessionCleanups } from './sessionCleanup';

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [user, setUser] = useState<User | null>(null);
  const [sessionEndRedirect, setSessionEndRedirect] = useState<string | null>(null);
  const [notice, setNotice] = useState<AuthNotice | null>(null);

  // Déconnexion en attente : finalisée dès le retour du réseau.
  useEffect(() => {
    if (notice !== 'logout-pending') return;
    const retry = () => {
      void completePendingLogout().then((done) => {
        if (done) setNotice(null);
      });
    };
    window.addEventListener('online', retry);
    return () => {
      window.removeEventListener('online', retry);
    };
  }, [notice]);
  const userIdRef = useRef<string | null>(null);

  /**
   * Fin de session / changement de compte : AUCUNE donnée d'un compte ne doit survivre.
   * Purge SYNCHRONE du cache Query (requêtes ET mutations en vol) avant tout nouvel état,
   * puis nettoyages hors-ligne (IndexedDB) en arrière-plan.
   */
  const wipe = useCallback(() => {
    void queryClient.cancelQueries();
    queryClient.getMutationCache().clear();
    queryClient.clear();
    void runSessionCleanups();
  }, [queryClient]);

  useEffect(() => {
    const off = onAuthEvent((e) => {
      if (e.type === 'session') {
        const previous = userIdRef.current;
        if (previous !== null && previous !== e.session.user.id) wipe(); // changement de compte : purge AVANT le nouvel utilisateur
        userIdRef.current = e.session.user.id;
        setNotice((n) => (n === 'csrf' ? null : n)); // session ouverte : l'ancien échec n'est plus d'actualité
        setSessionEndRedirect(null);
        setUser(e.session.user);
        setStatus('authenticated');
      } else {
        const hadUser = userIdRef.current !== null;
        userIdRef.current = null;
        // Purge du cache seulement si un compte était chargé : au démarrage anonyme (refresh refusé),
        // le cache ne contient que des données publiques en cours de chargement qu'il ne faut pas annuler.
        if (hadUser) wipe();
        else void runSessionCleanups();
        setUser(null);
        setStatus('anonymous');
      }
    });
    void (async () => {
      // Déconnexion restée en attente (faite hors-ligne) : la terminer AVANT tout refresh, ne jamais
      // restaurer la session (téléphone de contrôle prêté…).
      if (await isLogoutPending().catch(() => false)) {
        const done = await completePendingLogout();
        setNotice(done ? null : 'logout-pending');
        setStatus((s) => (s === 'loading' ? 'anonymous' : s));
        return;
      }
      // Restauration de session au chargement via le cookie HttpOnly (promesse partagée côté client).
      refreshSession().catch((err: unknown) => {
        if (isApiError(err) && err.code === 'SESSION_CHANGED') return; // un login/logout a eu lieu entre-temps
        if (isApiError(err) && err.code === 'CSRF_CHECK_FAILED') {
          // Requête bloquée par le contrôle anti-CSRF : réessayer ne changera rien ⇒ anonyme, avec un message.
          setNotice('csrf');
          setStatus((s) => (s === 'loading' ? 'anonymous' : s));
          return;
        }
        if (isApiError(err) && (err.code === 'NETWORK_ERROR' || err.code === 'TIMEOUT' || err.status >= 500)) {
          setStatus((s) => (s === 'loading' ? 'offline' : s));
        } else {
          setStatus((s) => (s === 'loading' ? 'anonymous' : s));
        }
      });
    })();
    return off;
  }, [wipe]);

  // Démarrage hors-ligne : la session est re-tentée dès le retour du réseau (synchro du scanner, billets…).
  useEffect(() => {
    if (status !== 'offline') return;
    const retry = () => {
      refreshSession().catch((err: unknown) => {
        if (isApiError(err) && err.code === 'CSRF_CHECK_FAILED') setNotice('csrf');
        // Refus définitif (session invalide, anti-CSRF) : plus d'état « hors-ligne » sans fin.
        if (isApiError(err) && (err.status === 401 || err.code === 'CSRF_CHECK_FAILED')) setStatus('anonymous');
      });
    };
    window.addEventListener('online', retry);
    return () => {
      window.removeEventListener('online', retry);
    };
  }, [status]);

  // Revérification de la session (pageshow persisté, page de QR redevenue visible).
  const [revalidating, setRevalidating] = useState(false);
  const [restoredFromCache, setRestoredFromCache] = useState(false);
  const revalidate = useCallback(async () => {
    if (userIdRef.current === null) return; // rien de personnel chargé
    setRevalidating(true);
    try {
      // Même compte ⇒ rien ne change ; autre compte (cookie remplacé par un autre onglet) ⇒ purge par
      // l'événement « session » ; session révoquée ⇒ purge par l'événement « expired ».
      await refreshSession();
    } catch {
      // Réseau absent : affichage conservé (billets hors-ligne) ; les autres cas sont traités par le client.
    } finally {
      setRevalidating(false);
    }
  }, []);
  useEffect(() => {
    // Page restaurée depuis le cache avant/arrière (bfcache) : l'état mémoire peut être celui d'une
    // session terminée ou d'un autre compte ⇒ contenu masqué jusqu'à la revérification.
    const onPageShow = (e: PageTransitionEvent) => {
      if (!e.persisted) return;
      setRestoredFromCache(true);
      void revalidate().finally(() => {
        setRestoredFromCache(false);
      });
    };
    window.addEventListener('pageshow', onPageShow);
    return () => {
      window.removeEventListener('pageshow', onPageShow);
    };
  }, [revalidate]);

  // Accès au contrôle d'entrée réécrits à chaque utilisateur reçu du serveur (refresh, /auth/me) :
  // un contrôleur retiré perd la liste locale des événements de ce collectif. Chargement à la demande.
  useEffect(() => {
    if (status !== 'authenticated' || !user) return;
    void import('../scanner/access').then((m) => m.rememberScannerAccess(user)).catch(() => undefined);
  }, [status, user]);

  const login = useCallback(async (email: string, password: string) => (await apiLogin(email, password)).user, []);
  /** La déconnexion n'est terminée qu'une fois les données hors-ligne effacées (billets = justificatifs). */
  const logout = useCallback(async () => {
    await apiLogout();
    await runSessionCleanups();
    if (await isLogoutPending().catch(() => false)) setNotice('logout-pending');
  }, []);
  const reloadUser = useCallback(async () => {
    const me = parseUser(await apiRequest<unknown>('/auth/me'));
    userIdRef.current = me.id;
    setUser(me);
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({ status, user, login, logout, reloadUser, sessionEndRedirect, setSessionEndRedirect, notice, revalidate, revalidating }),
    [status, user, login, logout, reloadUser, sessionEndRedirect, notice, revalidate, revalidating],
  );
  return (
    <AuthContext value={value}>
      {restoredFromCache ? (
        <p className="page" role="status">
          Vérification de la session…
        </p>
      ) : (
        children
      )}
    </AuthContext>
  );
}
