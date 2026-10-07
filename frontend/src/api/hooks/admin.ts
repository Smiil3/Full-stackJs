import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiPath, apiRequest } from '../client';
import { isApiError } from '../errors';
import type { Page, RefundAdmin, StuckOrder } from '../types';

/** Anomalies de la plateforme (contrat v1.17 §8) : remboursements sans commande, commandes bloquées. */
const KEY = ['admin', 'anomalies'] as const;

export const useAdminRefunds = (page: number) =>
  useQuery({
    queryKey: [...KEY, 'refunds', page],
    queryFn: ({ signal }) => apiRequest<Page<RefundAdmin>>('/admin/refunds', { query: { page, pageSize: 20 }, signal }),
    placeholderData: keepPreviousData,
  });

export function useAdminMarkRefundDone() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { refundId: string; note: string }) => apiRequest<RefundAdmin>(apiPath`/admin/refunds/${v.refundId}/mark-done`, { method: 'POST', body: { note: v.note } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: [...KEY, 'refunds'] }),
    onError: (e) => {
      if (isApiError(e) && e.code === 'INVALID_STATE') void qc.invalidateQueries({ queryKey: [...KEY, 'refunds'] });
    },
  });
}

export const useStuckOrders = (page: number) =>
  useQuery({
    queryKey: [...KEY, 'stuck', page],
    queryFn: ({ signal }) => apiRequest<Page<StuckOrder>>('/admin/stuck-orders', { query: { page, pageSize: 20 }, signal }),
    placeholderData: keepPreviousData,
  });

export function useRetryStuckOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (orderId: string) => apiRequest<StuckOrder>(apiPath`/admin/stuck-orders/${orderId}/retry`, { method: 'POST' }),
    onSettled: () => qc.invalidateQueries({ queryKey: [...KEY, 'stuck'] }),
  });
}
