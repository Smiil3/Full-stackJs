import { fetchSnapshot } from '../api/hooks/org';
import { isApiError } from '../api/errors';
import type { CheckinEvent, TicketStatus } from '../api/types';
import { currentGeneration, listSnapshots, pendingCount, purgeEvent, saveSnapshot, SCAN_LOCK, unseenConflictCount, withLock, type LocalTicket } from './db';
import { EventNotAvailableError } from './engine';

const STATUSES: readonly TicketStatus[] = ['VALID', 'USED', 'CANCELLED'];
const PUBLIC_ID = /^[A-Za-z0-9_-]{22}$/;

/** Le mode secours a été désactivé pour l'événement : liste locale purgée (la file non transmise reste). */
export class OfflineDisabledError extends Error {
  constructor() {
    super('Mode secours désactivé');
  }
}
/** Un autre événement a encore des passages non transmis ou des conflits non vus. */
export class OtherEventBlockedError extends Error {
  constructor(
    readonly title: string,
    readonly reason: 'pending' | 'conflicts',
  ) {
    super('Autre événement à traiter');
  }
}

/**
 * « Préparer l'entrée hors-ligne » (mode secours uniquement). Un seul événement préparé à la fois ;
 * l'événement précédent n'est purgé qu'une fois sa file transmise et ses conflits consultés.
 */
export async function prepareEvent(orgId: string, event: CheckinEvent, signal?: AbortSignal): Promise<{ ticketCount: number }> {
  const generation = await currentGeneration();
  for (const other of await listSnapshots()) {
    if (other.eventId === event.id) continue;
    if ((await pendingCount(other.eventId)) > 0) throw new OtherEventBlockedError(other.title, 'pending');
    if ((await unseenConflictCount(other.eventId)) > 0) throw new OtherEventBlockedError(other.title, 'conflicts');
  }
  let snap;
  try {
    snap = await fetchSnapshot(orgId, event.id, signal);
  } catch (e) {
    if (isApiError(e) && e.code === 'NOT_FOUND') throw new EventNotAvailableError();
    if (isApiError(e) && e.code === 'OFFLINE_CHECKIN_DISABLED') {
      await purgeEvent(event.id);
      throw new OfflineDisabledError();
    }
    throw e;
  }
  if (snap.eventId !== event.id) throw new Error('Liste reçue pour un autre événement');
  const tickets: LocalTicket[] = snap.tickets
    .filter((t) => PUBLIC_ID.test(t.publicId) && STATUSES.includes(t.status))
    .map((t) => ({ eventId: event.id, publicId: t.publicId, ticketTypeName: t.ticketTypeName, holderInitials: t.holderInitials, status: t.status, usedAt: t.usedAt }));
  // Mise à jour sous le même verrou que les scans : jamais de rétrogradation USED ⇒ VALID en concurrence.
  await withLock(SCAN_LOCK, async () => {
    for (const other of await listSnapshots()) if (other.eventId !== event.id) await purgeEvent(other.eventId);
    await saveSnapshot(
      {
        eventId: event.id,
        orgId,
        title: event.title,
        timezone: event.timezone,
        endsAt: event.endsAt,
        generatedAt: snap.generatedAt,
        savedAt: new Date().toISOString(),
        publicKeyJwk: snap.publicKeyJwk,
        ticketCount: tickets.length,
      },
      tickets,
      generation,
    );
  });
  return { ticketCount: tickets.length };
}
