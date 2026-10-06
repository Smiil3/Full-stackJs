import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiPath, apiRequest } from '../client';
import { qk } from '../queryKeys';
import type { Order, WaitlistEntry } from '../types';

export function useMyWaitlist(enabled: boolean) {
  return useQuery({
    queryKey: qk.waitlist(),
    queryFn: ({ signal }) => apiRequest<{ items: WaitlistEntry[] }>('/me/waitlist', { signal }),
    enabled,
    refetchInterval: 60_000,
  });
}

export function useJoinWaitlist() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { eventId: string; ticketTypeId: string; quantity: number }) =>
      apiRequest<WaitlistEntry>(apiPath`/events/${v.eventId}/ticket-types/${v.ticketTypeId}/waitlist`, { method: 'POST', body: { quantity: v.quantity } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.waitlist() }),
  });
}

export function useLeaveWaitlist() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (entryId: string) => apiRequest<undefined>(apiPath`/waitlist/${entryId}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.waitlist() }),
  });
}

export function useAcceptOffer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (entryId: string) => apiRequest<Order>(apiPath`/waitlist/${entryId}/accept`, { method: 'POST' }),
    onSuccess: (order) => {
      qc.setQueryData(qk.order(order.id), order);
      void qc.invalidateQueries({ queryKey: qk.waitlist() });
      void qc.invalidateQueries({ queryKey: ['orders'] });
    },
  });
}
