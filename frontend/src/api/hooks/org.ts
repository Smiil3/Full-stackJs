import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiPath, apiRequest } from '../client';
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
  TicketTypeAdmin,
  TicketTypeBody,
  TicketTypePatchBody,
} from '../types';

const org = (orgId: string) => apiPath`/orgs/${orgId}`;
const ev = (orgId: string, eventId: string) => apiPath`/orgs/${orgId}/events/${eventId}`;

// ---------------- Collectif ----------------
export const useOrg = (orgId: string) =>
  useQuery({ queryKey: qk.org(orgId), queryFn: ({ signal }) => apiRequest<Organization>(org(orgId), { signal }) });

export const useOrgSettings = (orgId: string, enabled = true) =>
  useQuery({ queryKey: qk.orgSettings(orgId), queryFn: ({ signal }) => apiRequest<OrgSettings>(`${org(orgId)}/settings`, { signal }), enabled });

export function useUpdateOrgSettings(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: OrgSettingsPatch) => apiRequest<OrgSettings>(`${org(orgId)}/settings`, { method: 'PATCH', body }),
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
    placeholderData: keepPreviousData,
  });

// ---------------- Événements ----------------
export const useOrgEvents = (orgId: string, status: EventStatus | undefined, page: number) =>
  useQuery({
    queryKey: qk.orgEvents(orgId, status, page),
    queryFn: ({ signal }) => apiRequest<Page<EventAdmin>>(`${org(orgId)}/events`, { query: { status, page, pageSize: 20 }, signal }),
    placeholderData: keepPreviousData,
  });

export const useOrgEvent = (orgId: string, eventId: string) =>
  useQuery({ queryKey: qk.orgEvent(orgId, eventId), queryFn: ({ signal }) => apiRequest<EventAdmin>(ev(orgId, eventId), { signal }) });

function useEventCache(orgId: string) {
  const qc = useQueryClient();
  return (e: EventAdmin) => {
    qc.setQueryData(qk.orgEvent(orgId, e.id), e);
    void qc.invalidateQueries({ queryKey: ['org', orgId, 'events'] });
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
    placeholderData: keepPreviousData,
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
    queryFn: ({ signal }) => apiRequest<EventStats>(`${ev(orgId, eventId)}/stats`, { signal }),
    refetchInterval: STATS_POLL_MS,
    refetchIntervalInBackground: false,
    retry: false,
  });

/** Export CSV : téléchargement authentifié (Bearer) puis Blob local — jamais de jeton dans une URL. */
export function useExportAttendees(orgId: string, eventId: string) {
  return useMutation({
    mutationFn: async () => {
      const blob = await apiRequest<Blob>(`${ev(orgId, eventId)}/attendees.csv`, { responseKind: 'blob', timeoutMs: 60_000 });
      const url = URL.createObjectURL(blob);
      try {
        const a = document.createElement('a');
        a.href = url;
        a.download = `participants-${eventId}.csv`;
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

// ---------------- Contrôle d'accès (utilisé par le scanner, F4) ----------------
export const useCheckinEvents = (orgId: string) =>
  useQuery({ queryKey: ['org', orgId, 'checkin-events'], queryFn: ({ signal }) => apiRequest<{ items: CheckinEvent[] }>(`${org(orgId)}/checkin/events`, { signal }) });

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
