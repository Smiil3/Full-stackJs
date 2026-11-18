/** Opérations métier du faux serveur (réservation, paiement, expiration, liste d'attente). */
import { control, fail, mock } from './core';
import { signQr, randomPublicId } from './crypto';
import { effectiveRules, type MockOrder, type MockRefund, type MockReschedule, type MockTicketType, type MockWaitlist } from './state';

const MIN = 60_000;
const HOUR = 3_600_000;
/** Anti-gel (contrat v1.18 §6). */
export const WAITLIST_LEAVE_GRACE_MS = 15 * MIN;
export const WAITLIST_OFFER_MIN_LEAD_MS = 15 * MIN;
export const MAX_UNHONORED_OFFERS_PER_EVENT = 2;

/** Expiration paresseuse : appelée avant chaque lecture/écriture de commandes (remplace le worker). */
export function expireDueOrders(now = Date.now()): void {
  const db = mock.db;
  for (const o of db.orders) {
    if ((o.status === 'PENDING_PAYMENT' || o.status === 'AWAITING_TRANSFER') && o.expiresAt && Date.parse(o.expiresAt) <= now) {
      o.status = 'EXPIRED';
      releaseHeld(o);
      // Commande issue d'une offre, expirée sans paiement ⇒ offre non honorée.
      const fromOffer = o.bodyFingerprint.startsWith('waitlist:') ? db.waitlist.find((w) => `waitlist:${w.id}` === o.bodyFingerprint) : undefined;
      if (fromOffer) recordUnhonoredOffer(fromOffer);
    }
  }
  for (const w of db.waitlist) {
    if (w.status === 'OFFERED' && w.offerExpiresAt && Date.parse(w.offerExpiresAt) <= now) {
      w.status = 'EXPIRED';
      const tt = db.ticketTypes.find((t) => t.id === w.ticketTypeId);
      if (tt) tt.held -= w.quantity;
      recordUnhonoredOffer(w);
      if (tt) offerToWaitlist(tt);
    }
  }
}

/** Nombre d'offres non honorées d'un compte sur un événement. */
export function unhonoredOffers(userId: string, eventId: string): number {
  return mock.db.waitlist.filter((w) => w.userId === userId && w.eventId === eventId && w.offerExpired).length;
}

/**
 * Offre non honorée (v1.18 §6) : à la MAX_UNHONORED_OFFERS_PER_EVENT-ième sur l'événement, les autres
 * inscriptions actives du compte sur cet événement passent EXPIRED (offres libérées, redistribuées).
 */
export function recordUnhonoredOffer(entry: MockWaitlist): void {
  entry.offerExpired = true;
  if (unhonoredOffers(entry.userId, entry.eventId) < MAX_UNHONORED_OFFERS_PER_EVENT) return;
  for (const other of mock.db.waitlist) {
    if (other.userId !== entry.userId || other.eventId !== entry.eventId) continue;
    if (other.status !== 'WAITING' && other.status !== 'OFFERED') continue;
    const wasOffered = other.status === 'OFFERED';
    other.status = 'EXPIRED';
    const tt = mock.db.ticketTypes.find((t) => t.id === other.ticketTypeId);
    if (tt && wasOffered) {
      tt.held -= other.quantity;
      offerToWaitlist(tt);
    }
  }
}

function releaseHeld(o: MockOrder): void {
  for (const item of o.items) {
    const tt = mock.db.ticketTypes.find((t) => t.id === item.ticketTypeId);
    if (!tt) continue;
    tt.held = Math.max(0, tt.held - item.quantity);
    offerToWaitlist(tt);
  }
}

/** Places libérées ⇒ d'abord au 1er WAITING (FIFO), sous forme d'offre qui garde les places. */
export function offerToWaitlist(tt: MockTicketType, now = Date.now()): void {
  const db = mock.db;
  const event = db.events.find((e) => e.id === tt.eventId);
  if (!event) return;
  const rules = effectiveRules(db, event);
  if (!rules.waitlistEnabled) return;
  const minutes = event.overrides.waitlistOfferMinutes ?? db.settings.get(event.orgId)?.waitlistOfferMinutes ?? 120;
  // Anti-gel : aucune offre à moins de 15 min de la fin des ventes (les places vont au public).
  const salesClose = Math.min(Date.parse(event.salesEndAt), Date.parse(event.startsAt));
  if (salesClose - now < WAITLIST_OFFER_MIN_LEAD_MS) return;
  const queue = db.waitlist
    .filter((w) => w.ticketTypeId === tt.id && w.status === 'WAITING')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  for (const w of queue) {
    if (tt.capacity - tt.sold - tt.held < w.quantity) break;
    tt.held += w.quantity;
    w.status = 'OFFERED';
    w.offeredAt = new Date(now).toISOString();
    w.offerExpiresAt = new Date(Math.min(now + minutes * MIN, salesClose)).toISOString();
  }
}

/** Report (v1.18) : échecs avant mise à l'écart d'une commande ; ancienneté au-delà de laquelle il est « bloqué ». */
export const RESCHEDULE_MAX_FAILURES = 5;
export const RESCHEDULE_STUCK_AFTER_MS = 15 * MIN;

/** Application d'un report aux commandes, par passages successifs (remplace le worker). */
export function runReschedule(r: MockReschedule): void {
  const step = () => {
    if (!mock.db.reschedules.includes(r)) return; // faux serveur réinitialisé
    for (const id of [...r.pending]) {
      if ((r.failures[id] ?? 0) >= RESCHEDULE_MAX_FAILURES) continue; // écartée jusqu'à relance
      if (control.failingRescheduleOrders.has(id)) {
        r.failures[id] = (r.failures[id] ?? 0) + 1;
        continue;
      }
      const o = mock.db.orders.find((x) => x.id === id);
      if (o?.status === 'PAID') {
        o.refundPercent = 100;
        o.serviceFeeRefundable = true;
      }
      r.pending = r.pending.filter((x) => x !== id);
    }
    if (r.pending.length === 0) r.completedAt = new Date().toISOString();
    else if (r.pending.some((id) => (r.failures[id] ?? 0) < RESCHEDULE_MAX_FAILURES)) setTimeout(step, control.rescheduleBatchDelayMs);
  };
  setTimeout(step, control.rescheduleBatchDelayMs);
}

/** Bloqué : pas terminé ET (une commande écartée, ou lancé il y a plus de 15 min). */
export function isRescheduleStuck(r: MockReschedule, now = Date.now()): boolean {
  if (r.completedAt) return false;
  return Object.values(r.failures).some((n) => n >= RESCHEDULE_MAX_FAILURES) || now - Date.parse(r.createdAt) > RESCHEDULE_STUCK_AFTER_MS;
}

export function holdDurations(eventId: string): { cardMs: number; transferMs: number } {
  const e = mock.db.events.find((x) => x.id === eventId);
  if (!e) return { cardMs: 15 * MIN, transferMs: 72 * HOUR };
  const r = effectiveRules(mock.db, e);
  return { cardMs: r.cardHoldMinutes * MIN, transferMs: r.transferHoldHours * HOUR };
}

/** held → sold, émission des billets signés (une seule fois par commande). */
export async function markPaid(o: MockOrder, now = Date.now()): Promise<void> {
  if (o.status === 'PAID') return;
  o.status = 'PAID';
  o.paidAt = new Date(now).toISOString();
  o.expiresAt = null;
  for (const item of o.items) {
    const tt = mock.db.ticketTypes.find((t) => t.id === item.ticketTypeId);
    if (tt) {
      tt.held = Math.max(0, tt.held - item.quantity);
      tt.sold += item.quantity;
    }
    for (let i = 0; i < item.quantity; i++) {
      const publicId = randomPublicId();
      mock.db.tickets.push({
        id: crypto.randomUUID(),
        orderId: o.id,
        eventId: o.eventId,
        ticketTypeId: item.ticketTypeId,
        publicId,
        qrPayload: await signQr(o.eventId, publicId),
        status: 'VALID',
        usedAt: null,
      });
    }
  }
}

/** Annulation acheteur : non payée ⇒ CANCELLED ; payée ⇒ REFUNDED + billets annulés. */
export function cancelOrder(o: MockOrder, reason: 'SELF_CANCELLATION' | 'EVENT_CANCELLED' = 'SELF_CANCELLATION'): void {
  if (o.status === 'PAID') {
    const feePart = o.serviceFeeRefundable ? o.serviceFeeCents : 0;
    o.refundAmountCents = Math.floor((o.subtotalCents * o.refundPercent) / 100) + feePart;
    o.status = 'REFUNDED';
    const now = new Date().toISOString();
    const orgId = mock.db.events.find((e) => e.id === o.eventId)?.orgId ?? '';
    // Contrat v1.10 : un remboursement de virement est toujours à effectuer à la main.
    mock.db.refunds.push({
      id: crypto.randomUUID(),
      orgId,
      orderId: o.id,
      eventId: o.eventId,
      amountCents: o.refundAmountCents,
      reason,
      method: o.paymentMethod,
      status: o.paymentMethod === 'TRANSFER' ? 'MANUAL_REQUIRED' : 'SUCCEEDED',
      note: null,
      createdAt: now,
      updatedAt: now,
    });
    for (const t of mock.db.tickets) if (t.orderId === o.id) t.status = 'CANCELLED';
    for (const item of o.items) {
      const tt = mock.db.ticketTypes.find((t) => t.id === item.ticketTypeId);
      if (tt) {
        tt.sold = Math.max(0, tt.sold - item.quantity);
        offerToWaitlist(tt);
      }
    }
    return;
  }
  o.status = 'CANCELLED';
  releaseHeld(o);
}

export function transferReference(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return `NG-${[...bytes].map((b) => alphabet[b % alphabet.length]).join('')}`;
}

/** Marquage manuel d'un remboursement (v1.17 §7.3 bis) : pour une carte, le prestataire est interrogé d'abord. */
export function markRefundDone(r: MockRefund, note: string): void {
  if (r.status !== 'MANUAL_REQUIRED' && r.status !== 'FAILED') fail(409, 'INVALID_STATE', 'Remboursement déjà traité');
  if (r.method === 'CARD' && r.pspState === 'unreachable') fail(503, 'PAYMENT_PROVIDER_UNAVAILABLE', 'Prestataire injoignable', undefined, { 'Retry-After': '5' });
  if (r.method === 'CARD' && r.pspState === 'pending') fail(409, 'INVALID_STATE', 'Remboursement en cours chez le prestataire');
  r.status = 'SUCCEEDED';
  r.note = note;
  r.updatedAt = new Date().toISOString();
}
