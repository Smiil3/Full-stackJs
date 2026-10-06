import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../../auth/AuthContext';
import { loadTickets, saveTickets } from '../../offline/tickets';
import { apiRequest } from '../client';
import { isApiError } from '../errors';
import { qk } from '../queryKeys';
import type { Ticket } from '../types';

export type TicketsResult = { tickets: Ticket[]; offline: boolean; savedAt: string | null };

/**
 * Billets : réseau d'abord ; en cas d'échec réseau, dernière liste enregistrée (affichage hors-ligne).
 */
export function useMyTickets() {
  const { user, status } = useAuth();
  return useQuery({
    // Clé liée au compte ET au statut : le résultat hors-ligne n'est pas réutilisé après le retour en ligne.
    queryKey: [...qk.tickets(), user?.id ?? 'inconnu', status],
    enabled: status === 'authenticated' || status === 'offline',
    networkMode: 'always',
    retry: false,
    queryFn: async ({ signal }): Promise<TicketsResult> => {
      if (status === 'authenticated' && user) {
        try {
          const { items } = await apiRequest<{ items: Ticket[] }>('/me/tickets', { signal });
          await saveTickets(user.id, items).catch(() => undefined);
          return { tickets: items, offline: false, savedAt: null };
        } catch (e) {
          if (!isApiError(e) || (e.code !== 'NETWORK_ERROR' && e.code !== 'TIMEOUT')) throw e;
        }
      }
      const saved = await loadTickets(user?.id ?? null);
      if (!saved) throw new Error('offline-empty');
      return { tickets: saved.tickets, offline: true, savedAt: saved.savedAt };
    },
  });
}
