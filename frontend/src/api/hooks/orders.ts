import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { apiPath, apiRequest } from '../client';
import { qk } from '../queryKeys';
import type { CheckoutResponse, CreateOrderBody, Order, Page } from '../types';

/**
 * Idempotency-Key : UNE clé par tentative de commande. Tant que le contenu du panier ne change pas,
 * la même clé est renvoyée (double clic, rejeu après coupure réseau ⇒ le serveur rend la même commande).
 * Un contenu différent = nouvelle tentative = nouvelle clé (évite IDEMPOTENCY_CONFLICT).
 */
export function useIdempotencyKey() {
  const ref = useRef<{ fingerprint: string; key: string } | null>(null);
  return {
    keyFor(fingerprint: string): string {
      if (ref.current?.fingerprint !== fingerprint) ref.current = { fingerprint, key: crypto.randomUUID() };
      return ref.current.key;
    },
    /** Après un succès : la prochaine commande sera une nouvelle tentative. */
    reset() {
      ref.current = null;
    },
  };
}

export function orderFingerprint(body: CreateOrderBody): string {
  const items = [...body.items].sort((a, b) => a.ticketTypeId.localeCompare(b.ticketTypeId));
  return JSON.stringify({ eventId: body.eventId, paymentMethod: body.paymentMethod, items });
}

export function useCreateOrder() {
  const qc = useQueryClient();
  const idem = useIdempotencyKey();
  const mutation = useMutation({
    mutationFn: (body: CreateOrderBody) =>
      apiRequest<Order>('/orders', { method: 'POST', body, headers: { 'Idempotency-Key': idem.keyFor(orderFingerprint(body)) } }),
    onSuccess: (order) => {
      idem.reset();
      qc.setQueryData(qk.order(order.id), order);
      void qc.invalidateQueries({ queryKey: ['orders'] });
      void qc.invalidateQueries({ queryKey: qk.event(order.eventId) });
      if (order.status === 'PAID') void qc.invalidateQueries({ queryKey: qk.tickets() });
    },
  });
  return mutation;
}

export function useOrders(page: number) {
  return useQuery({
    queryKey: qk.orders(page),
    queryFn: ({ signal }) => apiRequest<Page<Order>>('/orders', { query: { page, pageSize: 20 }, signal }),
  });
}

export function useOrder(orderId: string | undefined, opts: { pollUntilPaid?: boolean } = {}) {
  return useQuery({
    queryKey: qk.order(orderId ?? ''),
    queryFn: ({ signal }) => apiRequest<Order>(apiPath`/orders/${orderId ?? ''}`, { signal }),
    enabled: Boolean(orderId),
    refetchInterval: (q) => (opts.pollUntilPaid && q.state.data?.status === 'PENDING_PAYMENT' ? 2000 : false),
  });
}

/**
 * Commandes pour lesquelles un paiement a été lancé dans cette session (mémoire uniquement).
 * Tant que le serveur n'a pas confirmé, on ne repropose JAMAIS « Payer » (risque de double paiement).
 */
const checkoutLaunched = new Set<string>();
export const markCheckoutLaunched = (orderId: string) => checkoutLaunched.add(orderId);
export const wasCheckoutLaunched = (orderId: string) => checkoutLaunched.has(orderId);
export const __resetCheckoutLaunched = () => {
  checkoutLaunched.clear();
};

export function useCheckout() {
  return useMutation({ mutationFn: (orderId: string) => apiRequest<CheckoutResponse>(apiPath`/orders/${orderId}/checkout`, { method: 'POST' }) });
}

export function useCancelOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (orderId: string) => apiRequest<Order>(apiPath`/orders/${orderId}/cancel`, { method: 'POST' }),
    onSuccess: (order) => {
      qc.setQueryData(qk.order(order.id), order);
      void qc.invalidateQueries({ queryKey: ['orders'] });
      void qc.invalidateQueries({ queryKey: qk.tickets() });
      void qc.invalidateQueries({ queryKey: qk.event(order.eventId) });
    },
  });
}
