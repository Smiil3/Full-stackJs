import { useState } from 'react';

/**
 * Lit le jeton à usage unique d'un lien email (`?token=`) puis le retire de la barre d'adresse
 * (historique, captures d'écran, partage d'URL). Le jeton reste en mémoire le temps de l'action.
 */
export function useUrlToken(): string | null {
  const [token] = useState(() => {
    const url = new URL(window.location.href);
    const value = url.searchParams.get('token');
    if (value !== null) {
      url.searchParams.delete('token');
      window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
    }
    return value && value.length <= 512 ? value : null;
  });
  return token;
}
