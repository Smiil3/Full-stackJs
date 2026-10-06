import type {
  EventAdmin,
  EventPublic,
  EventSummary,
  Member,
  Order,
  OrderAdmin,
  OrgSettings,
  RefundAdmin,
  Ticket,
  TicketTypeAdmin,
  User,
  WaitlistEntry,
} from '../api/types';
import { mock } from './core';
import {
  availability,
  currentPrice,
  effectiveRules,
  maskIban,
  remaining,
  type MockEvent,
  type MockMembership,
  type MockRefund,
  type MockOrder,
  type MockSettings,
  type MockTicket,
  type MockTicketType,
  type MockUser,
  type MockWaitlist,
} from './state';

const db = () => mock.db;

export function toUser(u: MockUser): User {
  return {
    id: u.id,
    email: u.email,
    displayName: u.displayName,
    emailVerified: u.emailVerified,
    isPlatformAdmin: u.isPlatformAdmin,
    memberships: db()
      .memberships.filter((m) => m.userId === u.id)
      .flatMap((m) => {
        const org = db().orgs.find((o) => o.id === m.orgId);
        return org ? [{ orgId: org.id, orgName: org.name, orgSlug: org.slug, role: m.role }] : [];
      }),
  };
}

export function typesOf(eventId: string): MockTicketType[] {
  return db()
    .ticketTypes.filter((t) => t.eventId === eventId)
    .sort((a, b) => a.sortOrder - b.sortOrder);
}

export function toEventSummary(e: MockEvent): EventSummary {
  const org = db().orgs.find((o) => o.id === e.orgId);
  const types = typesOf(e.id);
  const open = types.filter((t) => availability(t) !== 'SOLD_OUT');
  const prices = (open.length ? open : types).map((t) => currentPrice(t).cents);
  const avail = types.map(availability);
  return {
    id: e.id,
    orgId: e.orgId,
    orgName: org?.name ?? '',
    orgSlug: org?.slug ?? '',
    title: e.title,
    venue: e.venue,
    isOnline: e.isOnline,
    startsAt: e.startsAt,
    endsAt: e.endsAt,
    timezone: e.timezone,
    coverAvailability: avail.every((a) => a === 'SOLD_OUT') ? 'SOLD_OUT' : avail.some((a) => a === 'AVAILABLE') ? 'AVAILABLE' : 'LOW',
    fromPriceCents: prices.length ? Math.min(...prices) : 0,
  };
}

export function salesOpen(e: MockEvent, now = Date.now()): boolean {
  return e.status === 'PUBLISHED' && now >= Date.parse(e.salesStartAt) && now < Date.parse(e.salesEndAt);
}

export function toEventPublic(e: MockEvent): EventPublic {
  return {
    ...toEventSummary(e),
    description: e.description,
    address: e.address,
    salesStartAt: e.salesStartAt,
    salesEndAt: e.salesEndAt,
    salesOpen: salesOpen(e),
    ticketTypes: typesOf(e.id).map((t) => {
      const p = currentPrice(t);
      return {
        id: t.id,
        name: t.name,
        description: t.description,
        currentPriceCents: p.cents,
        regularPriceCents: t.priceCents,
        isEarly: p.isEarly,
        earlyUntil: p.isEarly ? t.earlyUntil : null,
        availability: availability(t),
      };
    }),
    rules: effectiveRules(db(), e),
    contactEmail: db().settings.get(e.orgId)?.contactEmail ?? null,
  };
}

export function toTicketTypeAdmin(t: MockTicketType): TicketTypeAdmin {
  return {
    id: t.id,
    name: t.name,
    description: t.description,
    capacity: t.capacity,
    sold: t.sold,
    held: t.held,
    remaining: remaining(t),
    priceCents: t.priceCents,
    earlyPriceCents: t.earlyPriceCents,
    earlyUntil: t.earlyUntil,
    sortOrder: t.sortOrder,
  };
}

export function toEventAdmin(e: MockEvent): EventAdmin {
  return {
    id: e.id,
    orgId: e.orgId,
    title: e.title,
    description: e.description,
    venue: e.venue,
    address: e.address,
    isOnline: e.isOnline,
    startsAt: e.startsAt,
    endsAt: e.endsAt,
    timezone: e.timezone,
    status: e.status,
    salesStartAt: e.salesStartAt,
    salesEndAt: e.salesEndAt,
    overrides: { ...e.overrides },
    offlineCheckinEnabled: e.offlineCheckinEnabled,
    effectiveRules: effectiveRules(db(), e),
    ticketTypes: typesOf(e.id).map(toTicketTypeAdmin),
    cancellationPendingOrders: e.cancellationPending?.length ?? 0,
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
  };
}

/** Contrat v1.6 : formule de remboursement si l'annulation self-service est possible maintenant. */
function refundPreview(o: MockOrder): number | null {
  if (o.status === 'PENDING_PAYMENT' || o.status === 'AWAITING_TRANSFER') return 0;
  if (o.status !== 'PAID' || !o.cancellableUntil || Date.now() >= Date.parse(o.cancellableUntil)) return null;
  if (db().tickets.some((t) => t.orderId === o.id && t.status === 'USED')) return null;
  return Math.floor((o.subtotalCents * o.refundPercent) / 100) + (o.serviceFeeRefundable ? o.serviceFeeCents : 0);
}

function orderBase(o: MockOrder): Omit<Order, 'transferInstructions'> {
  const e = db().events.find((x) => x.id === o.eventId);
  return {
    id: o.id,
    eventId: o.eventId,
    eventTitle: e?.title ?? '',
    eventStartsAt: e?.startsAt ?? o.createdAt,
    eventTimezone: e?.timezone ?? 'Europe/Paris',
    status: o.status,
    paymentMethod: o.paymentMethod,
    items: o.items.map((i) => ({ ...i })),
    subtotalCents: o.subtotalCents,
    serviceFeeCents: o.serviceFeeCents,
    totalCents: o.totalCents,
    currency: 'EUR',
    expiresAt: o.expiresAt,
    paidAt: o.paidAt,
    cancellableUntil: o.cancellableUntil,
    refundPercent: o.refundPercent,
    refundAmountCents: o.refundAmountCents,
    refundPreviewCents: refundPreview(o),
    createdAt: o.createdAt,
  };
}

/** `transferInstructions` uniquement pour le propriétaire et si AWAITING_TRANSFER (contrat §4). */
export function toOrder(o: MockOrder): Order {
  let transferInstructions: Order['transferInstructions'] = null;
  if (o.status === 'AWAITING_TRANSFER' && o.transferReference) {
    const e = db().events.find((x) => x.id === o.eventId);
    const bank = e ? db().settings.get(e.orgId)?.bank : undefined;
    if (bank?.iban && bank.bic && bank.beneficiary) {
      transferInstructions = {
        beneficiary: bank.beneficiary,
        iban: bank.iban,
        bic: bank.bic,
        reference: o.transferReference,
        amountCents: o.totalCents,
        deadline: o.expiresAt ?? o.createdAt,
      };
    }
  }
  return { ...orderBase(o), transferInstructions };
}

export function toOrderAdmin(o: MockOrder): OrderAdmin {
  const buyer = db().users.find((u) => u.id === o.userId);
  const full = toOrder(o).transferInstructions;
  return {
    ...orderBase(o),
    transferInstructions: full ? { ...full, iban: maskIban(full.iban) ?? '' } : null,
    buyer: { id: o.userId, email: buyer?.email ?? '', displayName: buyer?.displayName ?? '' },
  };
}

export function toTicket(t: MockTicket): Ticket {
  const e = db().events.find((x) => x.id === t.eventId);
  const tt = db().ticketTypes.find((x) => x.id === t.ticketTypeId);
  return {
    id: t.id,
    publicId: t.publicId,
    status: t.status,
    usedAt: t.usedAt,
    qrPayload: t.qrPayload,
    ticketTypeName: tt?.name ?? '',
    orderId: t.orderId,
    event: {
      id: t.eventId,
      title: e?.title ?? '',
      venue: e?.venue ?? null,
      isOnline: e?.isOnline ?? false,
      startsAt: e?.startsAt ?? '',
      endsAt: e?.endsAt ?? '',
      timezone: e?.timezone ?? 'Europe/Paris',
    },
  };
}

export function toWaitlist(w: MockWaitlist): WaitlistEntry {
  const e = db().events.find((x) => x.id === w.eventId);
  const tt = db().ticketTypes.find((x) => x.id === w.ticketTypeId);
  const queue = db()
    .waitlist.filter((x) => x.ticketTypeId === w.ticketTypeId && x.status === 'WAITING')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  return {
    id: w.id,
    eventId: w.eventId,
    eventTitle: e?.title ?? '',
    ticketTypeId: w.ticketTypeId,
    ticketTypeName: tt?.name ?? '',
    quantity: w.quantity,
    status: w.status,
    position: w.status === 'WAITING' ? queue.findIndex((x) => x.id === w.id) + 1 : null,
    offerExpiresAt: w.offerExpiresAt,
    createdAt: w.createdAt,
  };
}

export function toSettings(s: MockSettings): OrgSettings {
  const { bank, ...rest } = s;
  return { ...rest, bank: { beneficiary: bank.beneficiary, ibanMasked: maskIban(bank.iban), bic: bank.bic } };
}

export function toMember(m: MockMembership): Member {
  const u = db().users.find((x) => x.id === m.userId);
  return { userId: m.userId, email: u?.email ?? '', displayName: u?.displayName ?? '', role: m.role, createdAt: m.createdAt };
}

export function toRefund(r: MockRefund): RefundAdmin {
  const e = db().events.find((x) => x.id === r.eventId);
  const o = db().orders.find((x) => x.id === r.orderId);
  const buyer = o && db().users.find((u) => u.id === o.userId);
  return {
    id: r.id,
    orderId: r.orderId,
    eventId: r.eventId,
    eventTitle: e?.title ?? '',
    buyerEmail: buyer?.email ?? '',
    amountCents: r.amountCents,
    reason: r.reason,
    method: r.method,
    status: r.status,
    note: r.note,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}
