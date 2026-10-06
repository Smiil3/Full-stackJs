import type { AdminOrdersQuery, EventsQuery } from './types';

/** Clés de cache centralisées. Toutes les données sont purgées au logout (queryClient.clear()). */
export const qk = {
  events: (q: EventsQuery) => ['events', q] as const,
  event: (id: string) => ['event', id] as const,
  orders: (page: number) => ['orders', page] as const,
  order: (id: string) => ['order', id] as const,
  tickets: () => ['tickets'] as const,
  waitlist: () => ['waitlist'] as const,
  org: (orgId: string) => ['org', orgId] as const,
  orgSettings: (orgId: string) => ['org', orgId, 'settings'] as const,
  orgMembers: (orgId: string) => ['org', orgId, 'members'] as const,
  orgAudit: (orgId: string, page: number) => ['org', orgId, 'audit', page] as const,
  orgEvents: (orgId: string, status?: string, page = 1) => ['org', orgId, 'events', status ?? 'ALL', page] as const,
  orgEvent: (orgId: string, eventId: string) => ['org', orgId, 'event', eventId] as const,
  orgEventOrders: (orgId: string, eventId: string, q: AdminOrdersQuery) => ['org', orgId, 'event', eventId, 'orders', q] as const,
  orgEventStats: (orgId: string, eventId: string) => ['org', orgId, 'event', eventId, 'stats'] as const,
  adminOrgs: () => ['admin', 'orgs'] as const,
};
