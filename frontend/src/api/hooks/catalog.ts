import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { apiPath, apiRequest } from '../client';
import { qk } from '../queryKeys';
import type { EventPublic, EventSummary, EventsQuery, Page } from '../types';

export function useEvents(query: EventsQuery) {
  return useQuery({
    queryKey: qk.events(query),
    queryFn: ({ signal }) => apiRequest<Page<EventSummary>>('/events', { auth: false, query, signal }),
    placeholderData: keepPreviousData,
  });
}

export function useEvent(eventId: string | undefined) {
  return useQuery({
    queryKey: qk.event(eventId ?? ''),
    queryFn: ({ signal }) => apiRequest<EventPublic>(apiPath`/events/${eventId ?? ''}`, { auth: false, signal }),
    enabled: Boolean(eventId),
    // La disponibilité bouge vite : on rafraîchit régulièrement tant que la page est ouverte.
    refetchInterval: 30_000,
  });
}
