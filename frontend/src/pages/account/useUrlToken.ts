import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';

/**
 * Jetons déjà retirés de l'URL, par chemin. Mémoire du module uniquement : en cas de remontage du
 * composant (StrictMode, navigation retour), le jeton n'est pas perdu alors qu'il n'est plus dans l'URL.
 */
const consumed = new Map<string, string>();

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
}
