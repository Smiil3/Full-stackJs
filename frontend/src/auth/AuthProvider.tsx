import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { apiRequest, completePendingLogout, login as apiLogin, logout as apiLogout, onAuthEvent, refreshSession } from '../api/client';
import { isLogoutPending } from '../offline/pendingLogout';
import { isApiError } from '../api/errors';
import { parseUser } from '../api/guards';
import type { User } from '../api/types';
import { AuthContext, type AuthContextValue, type AuthNotice, type AuthStatus } from './AuthContext';
import { runSessionCleanups } from './sessionCleanup';

/**
 * Retour depuis le cache du navigateur : au-delà de ce délai sans réponse du serveur, l'attente
 * devient un état « session non vérifiée » explicite (contenu toujours masqué, revérification continue).
 */
export const BFCACHE_CHECK_MAX_MS = 10_000;

/** Serveur injoignable (réseau, délai, 5xx) : la session n'a pas pu être vérifiée. */
function isUnreachable(err: unknown): boolean {
  return isApiError(err) && (err.code === 'NETWORK_ERROR' || err.code === 'TIMEOUT' || err.status >= 500);
}

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
        if (isUnreachable(err)) {
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
  /** Vrai si le serveur a répondu (ou rien de personnel n'est chargé) ; faux s'il est injoignable. */
  const verifySession = useCallback(async (): Promise<boolean> => {
    if (userIdRef.current === null) return true; // rien de personnel chargé
    setRevalidating(true);
    try {
      // Même compte ⇒ rien ne change ; autre compte (cookie remplacé par un autre onglet) ⇒ purge par
      // l'événement « session » ; session révoquée ⇒ purge par l'événement « expired ».
      await refreshSession();
      return true;
    } catch (err) {
      // Réseau absent : affichage conservé (billets hors-ligne) ; les autres cas sont traités par le client.
      return !isUnreachable(err);
    } finally {
      setRevalidating(false);
    }
  }, []);
  const revalidate = useCallback(async () => {
    await verifySession();
  }, [verifySession]);

  // Page restaurée depuis le cache avant/arrière (bfcache) : l'état mémoire peut être celui d'une
  // session terminée ou d'un autre compte ⇒ contenu MASQUÉ (pas démonté : formulaires et défilement
  // conservés, audit B17-f) jusqu'à ce que le SERVEUR ait répondu (audit n° 2, B'3) : jamais levé sur
  // un simple minuteur. Sans réponse en BFCACHE_CHECK_MAX_MS, ou serveur injoignable, état explicite
  // « session non vérifiée » (toujours masqué) ; nouvel essai au retour du réseau ou à la demande.
  const [cacheMask, setCacheMask] = useState<'none' | 'checking' | 'unverified'>('none');
  const checkGeneration = useRef(0);
  const checkRestoredSession = useCallback(() => {
    const generation = ++checkGeneration.current;
    setCacheMask('checking');
    const cap = setTimeout(() => {
      if (generation === checkGeneration.current) setCacheMask('unverified');
    }, BFCACHE_CHECK_MAX_MS);
    void verifySession().then((reached) => {
      // Une réponse tardive du serveur lève quand même le masque, y compris après le plafond.
      if (reached) {
        clearTimeout(cap);
        setCacheMask('none');
        checkGeneration.current++;
      } else if (generation === checkGeneration.current) {
        clearTimeout(cap);
        setCacheMask('unverified');
      }
    });
  }, [verifySession]);
  useEffect(() => {
    const onPageShow = (e: PageTransitionEvent) => {
      if (e.persisted) checkRestoredSession();
    };
    window.addEventListener('pageshow', onPageShow);
    return () => {
      window.removeEventListener('pageshow', onPageShow);
    };
  }, [checkRestoredSession]);
  useEffect(() => {
    if (cacheMask !== 'unverified') return;
    window.addEventListener('online', checkRestoredSession);
    return () => {
      window.removeEventListener('online', checkRestoredSession);
    };
  }, [cacheMask, checkRestoredSession]);
  const masked = cacheMask !== 'none';

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
      {cacheMask === 'checking' ? (
        <p className="page" role="status">
          Vérification de la session…
        </p>
      ) : null}
      {cacheMask === 'unverified' ? (
        <div className="page" role="alert">
          <p>Session non vérifiée : le serveur ne répond pas (hors connexion ?). Le contenu reste masqué tant que votre session n’a pas été vérifiée.</p>
          <button type="button" className="btn" onClick={checkRestoredSession}>
            Réessayer
          </button>
        </div>
      ) : null}
      <div className={masked ? 'session-masked' : 'session-visible'} inert={masked ? true : undefined} aria-hidden={masked ? true : undefined}>
        {children}
      </div>
    </AuthContext>
  );
}
