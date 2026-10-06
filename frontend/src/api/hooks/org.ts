import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiPath, apiRequest } from '../client';
import { ApiError, isApiError } from '../errors';
import { slugify } from '../../lib/slug';
import { parseEventStats, parseOrgSettings } from '../guards';
import { qk } from '../queryKeys';
import type {
  AdminOrdersQuery,
  AuditLogEntry,
  CheckinEvent,
  CheckinSnapshot,
  CreateOrgBody,
  EventAdmin,
  EventCreateBody,
  EventPatchBody,
  EventStats,
  EventStatus,
  Member,
  OrderAdmin,
  Organization,
  OrgRole,
  OrgSettings,
  OrgSettingsPatch,
  Page,
  RefundAdmin,
  RefundsQuery,
  TicketTypeAdmin,
  TicketTypeBody,
  TicketTypePatchBody,
} from '../types';

const org = (orgId: string) => apiPath`/orgs/${orgId}`;

/**
 * Données « précédentes » affichées pendant un rechargement (pagination, filtres) — UNIQUEMENT si elles
 * concernent le même collectif (et le même événement) : jamais les données de A sous l'en-tête de B.
 */
export function keepIfSameScope(orgId: string, eventId?: string) {
  return <T>(previous: T | undefined, previousQuery: { queryKey: readonly unknown[] } | undefined): T | undefined => {
    const key = previousQuery?.queryKey;
    if (key?.[0] !== 'org' || key[1] !== orgId) return undefined;
    if (eventId !== undefined && key[3] !== eventId) return undefined;
    return previous;
  };
}
const ev = (orgId: string, eventId: string) => apiPath`/orgs/${orgId}/events/${eventId}`;

// ---------------- Collectif ----------------
export const useOrg = (orgId: string) =>
  useQuery({ queryKey: qk.org(orgId), queryFn: ({ signal }) => apiRequest<Organization>(org(orgId), { signal }) });

export const useOrgSettings = (orgId: string, enabled = true) =>
  useQuery({ queryKey: qk.orgSettings(orgId), queryFn: async ({ signal }) => parseOrgSettings(await apiRequest<unknown>(`${org(orgId)}/settings`, { signal })), enabled });

/**
 * `sensitive` (coordonnées bancaires + mot de passe) : la mutation n'est pas conservée dans le cache
 * (gcTime 0) — l'appelant doit en plus appeler `reset()` une fois terminée.
 */
export function useUpdateOrgSettings(orgId: string, opts: { sensitive?: boolean } = {}) {
  const qc = useQueryClient();
  return useMutation({
    ...(opts.sensitive ? { gcTime: 0 } : {}),
    mutationFn: async (body: OrgSettingsPatch): Promise<OrgSettings> => parseOrgSettings(await apiRequest<unknown>(`${org(orgId)}/settings`, { method: 'PATCH', body })),
    onSuccess: (s) => {
      qc.setQueryData(qk.orgSettings(orgId), s);
      void qc.invalidateQueries({ queryKey: ['org', orgId, 'event'] });
      void qc.invalidateQueries({ queryKey: ['org', orgId, 'events'] });
    },
  });
}

export const useMembers = (orgId: string) =>
  useQuery({ queryKey: qk.orgMembers(orgId), queryFn: ({ signal }) => apiRequest<{ items: Member[] }>(`${org(orgId)}/members`, { signal }) });

export function useMemberMutations(orgId: string) {
  const qc = useQueryClient();
  const done = () => qc.invalidateQueries({ queryKey: qk.orgMembers(orgId) });
  return {
    add: useMutation({ mutationFn: (b: { email: string; role: OrgRole }) => apiRequest<Member>(`${org(orgId)}/members`, { method: 'POST', body: b }), onSuccess: done }),
    setRole: useMutation({
      mutationFn: (b: { userId: string; role: OrgRole }) => apiRequest<Member>(`${org(orgId)}${apiPath`/members/${b.userId}`}`, { method: 'PATCH', body: { role: b.role } }),
      onSuccess: done,
    }),
    remove: useMutation({ mutationFn: (userId: string) => apiRequest<undefined>(`${org(orgId)}${apiPath`/members/${userId}`}`, { method: 'DELETE' }), onSuccess: done }),
  };
}

export const useAuditLog = (orgId: string, page: number) =>
  useQuery({
    queryKey: qk.orgAudit(orgId, page),
    queryFn: ({ signal }) => apiRequest<Page<AuditLogEntry>>(`${org(orgId)}/audit-log`, { query: { page, pageSize: 25 }, signal }),
    placeholderData: keepIfSameScope(orgId),
  });

// ---------------- Événements ----------------
export const useOrgEvents = (orgId: string, status: EventStatus | undefined, page: number) =>
  useQuery({
    queryKey: qk.orgEvents(orgId, status, page),
    queryFn: ({ signal }) => apiRequest<Page<EventAdmin>>(`${org(orgId)}/events`, { query: { status, page, pageSize: 20 }, signal }),
    placeholderData: keepIfSameScope(orgId),
  });

export const useOrgEvent = (orgId: string, eventId: string) =>
  useQuery({ queryKey: qk.orgEvent(orgId, eventId), queryFn: ({ signal }) => apiRequest<EventAdmin>(ev(orgId, eventId), { signal }) });

function useEventCache(orgId: string) {
  const qc = useQueryClient();
  /** Après création / modification / publication / report / annulation : tout ce qui en dépend est périmé. */
  return (e: EventAdmin) => {
    qc.setQueryData(qk.orgEvent(orgId, e.id), e);
    void qc.invalidateQueries({ queryKey: ['org', orgId, 'events'] });
    void qc.invalidateQueries({ queryKey: ['org', orgId, 'event', e.id], predicate: (q) => q.queryKey.length > 4 }); // commandes, statistiques
    void qc.invalidateQueries({ queryKey: ['events'] }); // catalogue public
    void qc.invalidateQueries({ queryKey: qk.event(e.id) });
  };
}

export function useCreateEvent(orgId: string) {
  const store = useEventCache(orgId);
  return useMutation({ mutationFn: (b: EventCreateBody) => apiRequest<EventAdmin>(`${org(orgId)}/events`, { method: 'POST', body: b }), onSuccess: store });
}

export function useEventMutations(orgId: string, eventId: string) {
  const store = useEventCache(orgId);
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: qk.orgEvent(orgId, eventId) });
  const base = ev(orgId, eventId);
  return {
    update: useMutation({ mutationFn: (b: EventPatchBody) => apiRequest<EventAdmin>(base, { method: 'PATCH', body: b }), onSuccess: store }),
    publish: useMutation({ mutationFn: () => apiRequest<EventAdmin>(`${base}/publish`, { method: 'POST' }), onSuccess: store }),
    cancel: useMutation({ mutationFn: (reason: string) => apiRequest<EventAdmin>(`${base}/cancel`, { method: 'POST', body: { reason } }), onSuccess: store }),
    addType: useMutation({ mutationFn: (b: TicketTypeBody) => apiRequest<TicketTypeAdmin>(`${base}/ticket-types`, { method: 'POST', body: b }), onSuccess: refresh }),
    updateType: useMutation({
      mutationFn: (v: { id: string; body: TicketTypePatchBody }) => apiRequest<TicketTypeAdmin>(`${base}${apiPath`/ticket-types/${v.id}`}`, { method: 'PATCH', body: v.body }),
      onSuccess: refresh,
    }),
    deleteType: useMutation({ mutationFn: (id: string) => apiRequest<undefined>(`${base}${apiPath`/ticket-types/${id}`}`, { method: 'DELETE' }), onSuccess: refresh }),
  };
}

// ---------------- Commandes, virements, stats, export ----------------
export const useEventOrders = (orgId: string, eventId: string, q: AdminOrdersQuery) =>
  useQuery({
    queryKey: qk.orgEventOrders(orgId, eventId, q),
    queryFn: ({ signal }) => apiRequest<Page<OrderAdmin>>(`${ev(orgId, eventId)}/orders`, { query: { ...q, pageSize: 20 }, signal }),
    placeholderData: keepIfSameScope(orgId, eventId),
  });

export function useConfirmTransfer(orgId: string, eventId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { orderId: string; receivedAmountCents: number }) =>
      apiRequest<OrderAdmin>(`${org(orgId)}${apiPath`/orders/${v.orderId}/confirm-transfer`}`, { method: 'POST', body: { receivedAmountCents: v.receivedAmountCents } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['org', orgId, 'event', eventId] });
    },
  });
}

/** Statistiques en quasi temps réel : rafraîchies toutes les 5 s tant que l'onglet est visible. */
export const STATS_POLL_MS = 5000;
export const useEventStats = (orgId: string, eventId: string) =>
  useQuery({
    queryKey: qk.orgEventStats(orgId, eventId),
    queryFn: async ({ signal }): Promise<EventStats> => parseEventStats(await apiRequest<unknown>(`${ev(orgId, eventId)}/stats`, { signal })),
    // Arrêt définitif sur 403 / 404 (droits retirés, événement inexistant) : inutile d'insister.
    refetchInterval: (q) => (isApiError(q.state.error) && (q.state.error.status === 403 || q.state.error.status === 404) ? false : STATS_POLL_MS),
    refetchIntervalInBackground: false,
    retry: false,
  });

/** Export CSV : téléchargement authentifié (Bearer) puis Blob local — jamais de jeton dans une URL. */
export function useExportAttendees(orgId: string, eventId: string, eventTitle?: string) {
  return useMutation({
    mutationFn: async () => {
      const blob = await apiRequest<Blob>(`${ev(orgId, eventId)}/attendees.csv`, { responseKind: 'blob', timeoutMs: 60_000 });
      // On ne propose au téléchargement QUE du CSV (pas une page d'erreur HTML renvoyée par un proxy).
      if (!blob.type.toLowerCase().startsWith('text/csv')) throw new ApiError({ status: 200, code: 'UNEXPECTED_RESPONSE', message: 'not csv' });
      const url = URL.createObjectURL(blob);
      try {
        const a = document.createElement('a');
        a.href = url;
        const slug = eventTitle ? slugify(eventTitle) : '';
        a.download = slug ? `participants-${slug}.csv` : 'participants.csv';
        a.rel = 'noopener';
        document.body.append(a);
        a.click();
        a.remove();
      } finally {
        setTimeout(() => {
          URL.revokeObjectURL(url);
        }, 1000);
      }
    },
  });
}

// ---------------- Remboursements (v1.10) ----------------
export const useRefunds = (orgId: string, q: RefundsQuery) =>
  useQuery({
    queryKey: ['org', orgId, 'refunds', q],
    queryFn: ({ signal }) => apiRequest<Page<RefundAdmin>>(`${org(orgId)}/refunds`, { query: { ...q, pageSize: 20 }, signal }),
    placeholderData: keepIfSameScope(orgId),
  });

export function useMarkRefundDone(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { refundId: string; note: string }) => apiRequest<RefundAdmin>(`${org(orgId)}${apiPath`/refunds/${v.refundId}/mark-done`}`, { method: 'POST', body: { note: v.note } }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['org', orgId, 'refunds'] });
      void qc.invalidateQueries({ queryKey: qk.orgEventStats(orgId, r.eventId) });
    },
  });
}

// ---------------- Contrôle d'accès (utilisé par le scanner, F4) ----------------
export const useCheckinEvents = (orgId: string, enabled = true) =>
  useQuery({ queryKey: ['org', orgId, 'checkin-events'], queryFn: ({ signal }) => apiRequest<{ items: CheckinEvent[] }>(`${org(orgId)}/checkin/events`, { signal }), enabled });

export const fetchSnapshot = (orgId: string, eventId: string, signal?: AbortSignal) =>
  apiRequest<CheckinSnapshot>(`${ev(orgId, eventId)}/checkin/snapshot`, { signal, timeoutMs: 60_000 });

// ---------------- Admin plateforme ----------------
export const useAdminOrgs = (page: number) =>
  useQuery({
    queryKey: [...qk.adminOrgs(), page],
    queryFn: ({ signal }) => apiRequest<Page<Organization>>('/admin/orgs', { query: { page, pageSize: 20 }, signal }),
    placeholderData: keepPreviousData,
  });

export function useCreateOrg() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (b: CreateOrgBody) => apiRequest<Organization>('/admin/orgs', { method: 'POST', body: b }),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.adminOrgs() }),
  });
}
