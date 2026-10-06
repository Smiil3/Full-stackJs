import { fetchSnapshot } from '../api/hooks/org';
import type { CheckinEvent, TicketStatus } from '../api/types';
import { listSnapshots, pendingCount, purgeEvent, saveSnapshot, type LocalTicket } from './db';

const STATUSES: readonly TicketStatus[] = ['VALID', 'USED', 'CANCELLED'];
const PUBLIC_ID = /^[A-Za-z0-9_-]{22}$/;

/**
 * « Préparer l'entrée hors-ligne » : télécharge le snapshot et le stocke. Un seul événement préparé à
 * la fois : les données d'un autre événement (sans scans en attente) sont purgées.
 */
export async function prepareEvent(orgId: string, event: CheckinEvent, signal?: AbortSignal): Promise<{ ticketCount: number }> {
  const snap = await fetchSnapshot(orgId, event.id, signal);
  if (snap.eventId !== event.id) throw new Error('Liste reçue pour un autre événement');
  const tickets: LocalTicket[] = snap.tickets
    .filter((t) => PUBLIC_ID.test(t.publicId) && STATUSES.includes(t.status))
    .map((t) => ({ eventId: event.id, publicId: t.publicId, ticketTypeName: t.ticketTypeName, holderInitials: t.holderInitials, status: t.status, usedAt: t.usedAt }));
  for (const other of await listSnapshots()) {
    if (other.eventId !== event.id && (await pendingCount(other.eventId)) === 0) await purgeEvent(other.eventId);
  }
  await saveSnapshot(
    { eventId: event.id, orgId, title: event.title, timezone: event.timezone, generatedAt: snap.generatedAt, savedAt: new Date().toISOString(), publicKeyJwk: snap.publicKeyJwk, ticketCount: tickets.length },
    tickets,
  );
  return { ticketCount: tickets.length };
}
