import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../../auth/AuthContext';
import { registerSessionCleanup } from '../../auth/sessionCleanup';
import { apiPath, apiRequest, sessionGeneration } from '../client';
import { qk } from '../queryKeys';
import type { CheckoutResponse, CreateOrderBody, Order, Page } from '../types';

/**
 * Idempotency-Key : UNE clé par tentative de commande, conservée au niveau MODULE (survit au
 * démontage du formulaire, ex. aller-retour de page après une coupure réseau), indexée par
 * (utilisateur, empreinte du panier). Même panier ⇒ même clé ⇒ le serveur rend la même commande.
 * Panier différent ⇒ nouvelle clé. Clé oubliée après confirmation et à la fin de session.
 */
const attemptKeys = new Map<string, string>();
registerSessionCleanup(() => {
  attemptKeys.clear();
});

/**
 * Mutation liée à la session qui l'a lancée : si un login / logout survient pendant l'échange,
 * le résultat n'est pas écrit dans le cache du nouveau compte.
 */
export const captureSession = () => ({ gen: sessionGeneration() });
export const sameSession = (ctx: { gen: number } | undefined) => ctx !== undefined && ctx.gen === sessionGeneration();

export function idempotencyKeyFor(userId: string, fingerprint: string): string {
  const slot = `${userId}|${fingerprint}`;
  let key = attemptKeys.get(slot);
  if (!key) {
    key = crypto.randomUUID();
    attemptKeys.set(slot, key);
  }
  return key;
}

export function forgetIdempotencyKey(userId: string, fingerprint: string): void {
  attemptKeys.delete(`${userId}|${fingerprint}`);
}

/** Empreinte canonique du panier ; refuse un panier incohérent (type de place en double). */
export function orderFingerprint(body: CreateOrderBody): string {
  const ids = body.items.map((i) => i.ticketTypeId);
  if (new Set(ids).size !== ids.length) throw new Error('Panier invalide : type de place en double');
  const items = [...body.items].sort((a, b) => a.ticketTypeId.localeCompare(b.ticketTypeId));
  return JSON.stringify({ eventId: body.eventId, paymentMethod: body.paymentMethod, items });
}

export function useCreateOrder() {
  const qc = useQueryClient();
  const { user } = useAuth();
  const userId = user?.id ?? 'anonyme';
  return useMutation({
    mutationFn: (body: CreateOrderBody) =>
      apiRequest<Order>('/orders', { method: 'POST', body, headers: { 'Idempotency-Key': idempotencyKeyFor(userId, orderFingerprint(body)) } }),
    onMutate: captureSession,
    onSuccess: (order, body, ctx) => {
      if (!sameSession(ctx)) return;
      forgetIdempotencyKey(userId, orderFingerprint(body));
      qc.setQueryData(qk.order(userId, order.id), order);
      void qc.invalidateQueries({ queryKey: ['orders'] });
      void qc.invalidateQueries({ queryKey: qk.event(order.eventId) });
      if (order.status === 'PAID') void qc.invalidateQueries({ queryKey: qk.tickets() });
    },
  });
}

export function useOrders(page: number) {
  const { user } = useAuth();
  return useQuery({
    queryKey: qk.orders(user?.id ?? 'anonyme', page),
    queryFn: ({ signal }) => apiRequest<Page<Order>>('/orders', { query: { page, pageSize: 20 }, signal }),
  });
}

/**
 * Suivi d'une commande. Polling tant qu'elle attend un paiement ET qu'un paiement est en cours selon le
 * serveur (`paymentInProgress`, v1.16) ou annoncé par le retour du PSP — ce retour ne prouve rien seul.
 */
export function useOrder(orderId: string | undefined, opts: { poll?: boolean; paymentReturned?: boolean } = {}) {
  const { user } = useAuth();
  return useQuery({
    queryKey: qk.order(user?.id ?? 'anonyme', orderId ?? ''),
    queryFn: ({ signal }) => apiRequest<Order>(apiPath`/orders/${orderId ?? ''}`, { signal }),
    enabled: Boolean(orderId),
    refetchInterval: (q) => {
      const d = q.state.data;
      return opts.poll && d?.status === 'PENDING_PAYMENT' && (opts.paymentReturned || d.paymentInProgress) ? 2000 : false;
    },
  });
}

export function useCheckout() {
  return useMutation({ mutationFn: (orderId: string) => apiRequest<CheckoutResponse>(apiPath`/orders/${orderId}/checkout`, { method: 'POST' }) });
}

export function useCancelOrder() {
  const qc = useQueryClient();
  const { user } = useAuth();
  const userId = user?.id ?? 'anonyme';
  return useMutation({
    mutationFn: (orderId: string) => apiRequest<Order>(apiPath`/orders/${orderId}/cancel`, { method: 'POST' }),
    onMutate: captureSession,
    onSuccess: (order, _orderId, ctx) => {
      if (!sameSession(ctx)) return;
      qc.setQueryData(qk.order(userId, order.id), order);
      void qc.invalidateQueries({ queryKey: ['orders'] });
      void qc.invalidateQueries({ queryKey: qk.tickets() });
      void qc.invalidateQueries({ queryKey: qk.event(order.eventId) });
    },
  });
}
