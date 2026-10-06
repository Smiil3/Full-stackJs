import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { onAuthEvent } from '../../api/client';

/**
 * Jetons déjà retirés de l'URL, par chemin. Mémoire du module uniquement : en cas de remontage du
 * composant (StrictMode, navigation retour), le jeton n'est pas perdu alors qu'il n'est plus dans l'URL.
 */
const consumed = new Map<string, string>();
// Déconnexion, fin d'une session ouverte ou changement de compte : aucun jeton de lien email ne
// survit pour la personne suivante. (Le démarrage anonyme ne les efface pas : remontage.)
let sessionUser: string | null = null;
let unsubscribe: (() => void) | null = null;
function watchSessionEnd(): void {
  unsubscribe ??= onAuthEvent((e) => {
    if (e.type === 'session') {
      if (sessionUser !== null && sessionUser !== e.session.user.id) consumed.clear();
      sessionUser = e.session.user.id;
    } else {
      if (e.type === 'logout' || sessionUser !== null) consumed.clear();
      sessionUser = null;
    }
  });
}

/**
 * Lit le jeton à usage unique d'un lien email (`?token=`) puis le retire de la barre d'adresse
 * (historique, captures d'écran, partage d'URL) — dans un effet, jamais pendant le rendu.
 */
export function useUrlToken(): string | null {
  const location = useLocation();
  const navigate = useNavigate();
  const [token] = useState(() => {
    const fromUrl = new URLSearchParams(location.search).get('token');
    if (fromUrl !== null) return fromUrl.length <= 512 ? fromUrl : null;
    return consumed.get(location.pathname) ?? null;
  });

  useEffect(watchSessionEnd, []);

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    if (!params.has('token')) return;
    if (token) consumed.set(location.pathname, token);
    params.delete('token');
    const search = params.toString();
    void navigate({ pathname: location.pathname, search: search ? `?${search}` : '', hash: location.hash }, { replace: true });
  }, [location.pathname, location.search, location.hash, navigate, token]);

  return token;
}

/** Réservé aux tests. */
export function __resetUrlTokens(): void {
  consumed.clear();
  unsubscribe?.();
  unsubscribe = null;
  sessionUser = null;
}
