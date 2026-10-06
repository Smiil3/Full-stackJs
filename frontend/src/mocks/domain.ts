/** Opérations métier du faux serveur (réservation, paiement, expiration, liste d'attente). */
import { mock } from './core';
import { signQr, randomPublicId } from './crypto';
import { effectiveRules, type MockOrder, type MockTicketType } from './state';

const MIN = 60_000;
const HOUR = 3_600_000;

/** Expiration paresseuse : appelée avant chaque lecture/écriture de commandes (remplace le worker). */
export function expireDueOrders(now = Date.now()): void {
  const db = mock.db;
  for (const o of db.orders) {
    if ((o.status === 'PENDING_PAYMENT' || o.status === 'AWAITING_TRANSFER') && o.expiresAt && Date.parse(o.expiresAt) <= now) {
      o.status = 'EXPIRED';
      releaseHeld(o);
    }
  }
  for (const w of db.waitlist) {
    if (w.status === 'OFFERED' && w.offerExpiresAt && Date.parse(w.offerExpiresAt) <= now) {
      w.status = 'EXPIRED';
      const tt = db.ticketTypes.find((t) => t.id === w.ticketTypeId);
      if (tt) {
        tt.held -= w.quantity;
        offerToWaitlist(tt);
      }
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
  const queue = db.waitlist
    .filter((w) => w.ticketTypeId === tt.id && w.status === 'WAITING')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  for (const w of queue) {
    if (tt.capacity - tt.sold - tt.held < w.quantity) break;
    tt.held += w.quantity;
    w.status = 'OFFERED';
    w.offerExpiresAt = new Date(now + minutes * MIN).toISOString();
  }
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
export function cancelOrder(o: MockOrder): void {
  if (o.status === 'PAID') {
    const feePart = o.serviceFeeRefundable ? o.serviceFeeCents : 0;
    o.refundAmountCents = Math.floor((o.subtotalCents * o.refundPercent) / 100) + feePart;
    o.status = 'REFUNDED';
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
