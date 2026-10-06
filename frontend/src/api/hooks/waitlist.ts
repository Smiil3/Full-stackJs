import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../../auth/AuthContext';
import { apiPath, apiRequest } from '../client';
import { captureSession, sameSession } from './orders';
import { qk } from '../queryKeys';
import type { Order, WaitlistEntry } from '../types';

export function useMyWaitlist(enabled: boolean) {
  const { user } = useAuth();
  return useQuery({
    queryKey: qk.waitlist(user?.id ?? 'anonyme'),
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
    onMutate: captureSession,
    onSuccess: (_r, _v, ctx) => (sameSession(ctx) ? qc.invalidateQueries({ queryKey: ['waitlist'] }) : undefined),
  });
}

export function useLeaveWaitlist() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (entryId: string) => apiRequest<undefined>(apiPath`/waitlist/${entryId}`, { method: 'DELETE' }),
    onMutate: captureSession,
    onSuccess: (_r, _v, ctx) => (sameSession(ctx) ? qc.invalidateQueries({ queryKey: ['waitlist'] }) : undefined),
  });
}

export function useAcceptOffer() {
  const qc = useQueryClient();
  const { user } = useAuth();
  const userId = user?.id ?? 'anonyme';
  return useMutation({
    mutationFn: (entryId: string) => apiRequest<Order>(apiPath`/waitlist/${entryId}/accept`, { method: 'POST' }),
    onMutate: captureSession,
    onSuccess: (order, _entryId, ctx) => {
      if (!sameSession(ctx)) return;
      qc.setQueryData(qk.order(userId, order.id), order);
      void qc.invalidateQueries({ queryKey: ['waitlist'] });
      void qc.invalidateQueries({ queryKey: ['orders'] });
    },
  });
}
