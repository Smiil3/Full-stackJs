import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../../auth/AuthContext';
import { registerSessionCleanup } from '../../auth/sessionCleanup';
import { apiPath, apiRequest, sessionGeneration } from '../client';
import { isApiError } from '../errors';
import { qk } from '../queryKeys';
import type { CheckoutResponse, CreateOrderBody, Order, Page } from '../types';

/**
 * Idempotency-Key : UNE clé par tentative de commande, conservée au niveau MODULE (survit au
 * démontage du formulaire, ex. aller-retour de page après une coupure réseau), indexée par
 * (utilisateur, empreinte du panier). Même panier ⇒ même clé ⇒ le serveur rend la même commande.
 * Panier différent ⇒ nouvelle clé. Clé OUBLIÉE (audit M5) : après confirmation, quand la commande
 * rendue est EXPIRED / CANCELLED (une clé = une commande pour toujours), sur erreur non transitoire,
 * après ATTEMPT_KEY_TTL_MS, et à la fin de session. Seules les erreurs transitoires (réseau, délai,
 * 5xx, 429) la conservent : c'est là qu'un rejeu doit retrouver la même commande.
 */
export const ATTEMPT_KEY_TTL_MS = 30 * 60_000;
const attemptKeys = new Map<string, { key: string; createdAt: number }>();
registerSessionCleanup(() => {
  attemptKeys.clear();
});

/**
 * Mutation liée à la session qui l'a lancée : si un login / logout survient pendant l'échange,
 * le résultat n'est pas écrit dans le cache du nouveau compte.
 */
export const captureSession = () => ({ gen: sessionGeneration() });
export const sameSession = (ctx: { gen: number } | undefined) => ctx !== undefined && ctx.gen === sessionGeneration();

export function idempotencyKeyFor(userId: string, fingerprint: string, now: number = Date.now()): string {
  const slot = `${userId}|${fingerprint}`;
  const kept = attemptKeys.get(slot);
  if (kept && now - kept.createdAt < ATTEMPT_KEY_TTL_MS) return kept.key;
  const key = crypto.randomUUID();
  attemptKeys.set(slot, { key, createdAt: now });
  return key;
}

/** Erreurs après lesquelles un rejeu doit retrouver la MÊME commande (la clé est conservée). */
export function isTransientOrderError(e: unknown): boolean {
  if (!isApiError(e)) return true; // erreur inconnue : prudence, la commande a pu être créée
  return e.code === 'NETWORK_ERROR' || e.code === 'TIMEOUT' || e.code === 'RATE_LIMITED' || e.code === 'SESSION_CHANGED' || e.status >= 500;
}

/**
 * Envoie la commande avec la clé de la tentative. Commande rendue déjà EXPIRED / CANCELLED (réponse
 * perdue d'une tentative ancienne) ⇒ clé oubliée et UN nouvel envoi avec une clé neuve.
 */
export async function createOrderWithKey(userId: string, body: CreateOrderBody, post: (key: string) => Promise<Order>): Promise<Order> {
  const fingerprint = orderFingerprint(body);
  try {
    const order = await post(idempotencyKeyFor(userId, fingerprint));
    if (order.status !== 'EXPIRED' && order.status !== 'CANCELLED') return order;
    forgetIdempotencyKey(userId, fingerprint);
    return await post(idempotencyKeyFor(userId, fingerprint));
  } catch (e) {
    if (!isTransientOrderError(e)) forgetIdempotencyKey(userId, fingerprint);
    throw e;
  }
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
      createOrderWithKey(userId, body, (key) => apiRequest<Order>('/orders', { method: 'POST', body, headers: { 'Idempotency-Key': key } })),
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

export function useOrders(page: number, enabled = true) {
  const { user } = useAuth();
  return useQuery({
    enabled,
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
