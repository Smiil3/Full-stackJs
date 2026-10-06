import type { PaymentMethod } from '../../api/types';
import { currentUser, fail, json, mock, noContent, notFound, param, paginate, readBody, readQuery, requireVerified, route } from '../core';
import { cancelOrder, expireDueOrders, holdDurations, markPaid, transferReference } from '../domain';
import { salesOpen, toEventPublic, toEventSummary, toOrder, toTicket, toWaitlist } from '../serializers';
import { currentPrice, effectiveRules, remaining, serviceFee, type MockOrder } from '../state';

const ACTIVE_ORDER = new Set(['PENDING_PAYMENT', 'AWAITING_TRANSFER', 'PAID']);

function ownOrder(request: Request, orderId: string): MockOrder {
  const user = currentUser(request);
  expireDueOrders();
  const o = mock.db.orders.find((x) => x.id === orderId && x.userId === user.id);
  return o ?? notFound();
}

export const buyerHandlers = [
  // ---------------- Catalogue ----------------
  route('get', '/events', ({ url }) => {
    const q = readQuery(url, ['orgSlug', 'from', 'to']);
    const now = Date.now();
    const orgSlug = q.get('orgSlug');
    const from = q.get('from');
    const to = q.get('to');
    const list = mock.db.events
      .filter((e) => e.status === 'PUBLISHED' && Date.parse(e.endsAt) > now)
      .filter((e) => !orgSlug || mock.db.orgs.find((o) => o.id === e.orgId)?.slug === orgSlug)
      .filter((e) => !from || Date.parse(e.startsAt) >= Date.parse(from))
      .filter((e) => !to || Date.parse(e.startsAt) <= Date.parse(to))
      .sort((a, b) => a.startsAt.localeCompare(b.startsAt))
      .map(toEventSummary);
    return json(paginate(list, q.page, q.pageSize));
  }),

  route('get', '/events/:eventId', ({ params }) => {
    expireDueOrders();
    const e = mock.db.events.find((x) => x.id === param(params, 'eventId') && x.status === 'PUBLISHED');
    return json(toEventPublic(e ?? notFound()));
  }),

  // ---------------- Commandes ----------------
  route('post', '/orders', async ({ request }) => {
    const user = currentUser(request);
    requireVerified(user);
    expireDueOrders();
    const key = request.headers.get('Idempotency-Key') ?? '';
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(key)) {
      fail(400, 'VALIDATION_ERROR', 'Idempotency-Key requise', { fields: [{ path: 'Idempotency-Key', message: 'UUID requis' }] });
    }
    const v = await readBody(request, ['eventId', 'paymentMethod', 'items']);
    const eventId = v.uuid('eventId');
    const method = v.oneOf<PaymentMethod>('paymentMethod', ['CARD', 'TRANSFER']);
    const rawItems = v.body.items;
    const items: { ticketTypeId: string; quantity: number }[] = [];
    if (!Array.isArray(rawItems) || rawItems.length < 1 || rawItems.length > 10) {
      v.custom('items', 'Entre 1 et 10 lignes');
    } else {
      rawItems.forEach((it: unknown, i) => {
        const o = (it ?? {}) as Record<string, unknown>;
        const extra = Object.keys(o).filter((k) => k !== 'ticketTypeId' && k !== 'quantity');
        if (extra.length) v.custom(`items.${i}`, 'Champ non autorisé');
        if (typeof o.ticketTypeId !== 'string') v.custom(`items.${i}.ticketTypeId`, 'Champ requis');
        if (typeof o.quantity !== 'number' || !Number.isInteger(o.quantity) || o.quantity < 1) v.custom(`items.${i}.quantity`, 'Entier ≥ 1');
        else if (typeof o.ticketTypeId === 'string') items.push({ ticketTypeId: o.ticketTypeId, quantity: o.quantity });
      });
      if (new Set(items.map((i) => i.ticketTypeId)).size !== items.length) v.custom('items', 'Types de places en double');
    }
    v.done();

    const fingerprint = JSON.stringify({ eventId, method, items: [...items].sort((a, b) => a.ticketTypeId.localeCompare(b.ticketTypeId)) });
    const previous = mock.db.orders.find((o) => o.userId === user.id && o.idempotencyKey === key);
    if (previous) {
      if (previous.bodyFingerprint !== fingerprint) fail(409, 'IDEMPOTENCY_CONFLICT', 'Clé déjà utilisée avec un autre contenu');
      return json(toOrder(previous), 200);
    }

    const event = mock.db.events.find((e) => e.id === eventId && e.status !== 'DRAFT');
    if (!event) return notFound();
    if (!salesOpen(event)) fail(409, 'SALES_CLOSED', 'Ventes fermées');
    const rules = effectiveRules(mock.db, event);
    if (method === 'TRANSFER' && !rules.transferEnabled) fail(422, 'PAYMENT_METHOD_UNAVAILABLE', 'Virement indisponible');
    const qty = items.reduce((s, i) => s + i.quantity, 0);
    if (qty > rules.maxPerOrder) fail(422, 'LIMIT_EXCEEDED', 'Plafond par commande', { max: rules.maxPerOrder, alreadyOwned: 0 });
    const owned = mock.db.orders
      .filter((o) => o.userId === user.id && o.eventId === event.id && ACTIVE_ORDER.has(o.status))
      .reduce((s, o) => s + o.items.reduce((a, i) => a + i.quantity, 0), 0);
    if (owned + qty > rules.maxPerUser) fail(422, 'LIMIT_EXCEEDED', 'Plafond par personne', { max: rules.maxPerUser, alreadyOwned: owned });

    const types = items.map((i) => {
      const tt = mock.db.ticketTypes.find((t) => t.id === i.ticketTypeId && t.eventId === event.id);
      if (!tt) return fail(400, 'VALIDATION_ERROR', 'Type de place inconnu', { fields: [{ path: 'items', message: 'Type de place inconnu' }] });
      if (remaining(tt) < i.quantity) fail(409, 'SOLD_OUT', 'Plus assez de places', { ticketTypeId: tt.id });
      return { tt, quantity: i.quantity };
    });
    for (const { tt, quantity } of types) tt.held += quantity;

    const now = Date.now();
    const lines = types.map(({ tt, quantity }) => ({ ticketTypeId: tt.id, name: tt.name, quantity, unitPriceCents: currentPrice(tt, now).cents }));
    const subtotal = lines.reduce((s, l) => s + l.unitPriceCents * l.quantity, 0);
    const fee = serviceFee(subtotal, rules);
    const holds = holdDurations(event.id);
    const settings = mock.db.settings.get(event.orgId);
    const order: MockOrder = {
      id: crypto.randomUUID(),
      userId: user.id,
      eventId: event.id,
      status: method === 'TRANSFER' ? 'AWAITING_TRANSFER' : 'PENDING_PAYMENT',
      paymentMethod: method ?? 'CARD',
      items: lines,
      subtotalCents: subtotal,
      serviceFeeCents: fee,
      totalCents: subtotal + fee,
      expiresAt: new Date(now + (method === 'TRANSFER' ? holds.transferMs : holds.cardMs)).toISOString(),
      paidAt: null,
      cancellableUntil: rules.selfCancellationEnabled ? new Date(Date.parse(event.startsAt) - rules.cancellationDeadlineHours * 3_600_000).toISOString() : null,
      refundPercent: rules.refundPercent,
      serviceFeeRefundable: settings?.serviceFeeRefundable ?? false,
      refundAmountCents: null,
      createdAt: new Date(now).toISOString(),
      transferReference: method === 'TRANSFER' ? transferReference() : null,
      idempotencyKey: key,
      bodyFingerprint: fingerprint,
    };
    mock.db.orders.push(order);
    if (order.totalCents === 0) await markPaid(order); // contrat v1.2 : commande gratuite ⇒ PAID directement
    return json(toOrder(order), 201);
  }),

  route('get', '/orders', ({ request, url }) => {
    const user = currentUser(request);
    expireDueOrders();
    const q = readQuery(url, []);
    const list = mock.db.orders
      .filter((o) => o.userId === user.id)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(toOrder);
    return json(paginate(list, q.page, q.pageSize));
  }),

  route('get', '/orders/:orderId', ({ request, params }) => json(toOrder(ownOrder(request, param(params, 'orderId'))))),

  route('post', '/orders/:orderId/checkout', ({ request, params, url }) => {
    const o = ownOrder(request, param(params, 'orderId'));
    if (o.status === 'EXPIRED') fail(409, 'ORDER_EXPIRED', 'Réservation expirée');
    if (o.status !== 'PENDING_PAYMENT' || o.paymentMethod !== 'CARD') fail(409, 'INVALID_STATE', 'Commande non payable');
    return json({ redirectUrl: `${url.origin}/mock-psp/${o.id}` });
  }),

  route('post', '/orders/:orderId/cancel', ({ request, params }) => {
    const o = ownOrder(request, param(params, 'orderId'));
    if (o.status === 'PENDING_PAYMENT' || o.status === 'AWAITING_TRANSFER') {
      cancelOrder(o);
      return json(toOrder(o));
    }
    if (o.status !== 'PAID') fail(409, 'INVALID_STATE', 'Commande non annulable');
    const scanned = mock.db.tickets.some((t) => t.orderId === o.id && t.status === 'USED');
    if (!o.cancellableUntil || Date.now() >= Date.parse(o.cancellableUntil) || scanned) fail(409, 'CANCELLATION_CLOSED', 'Annulation fermée');
    cancelOrder(o);
    return json(toOrder(o));
  }),

  // ---------------- Billets ----------------
  route('get', '/me/tickets', ({ request }) => {
    const user = currentUser(request);
    const orderIds = new Set(mock.db.orders.filter((o) => o.userId === user.id).map((o) => o.id));
    const now = Date.now();
    const items = mock.db.tickets
      .filter((t) => orderIds.has(t.orderId))
      .map(toTicket)
      .sort((a, b) => {
        const pa = Date.parse(a.event.endsAt) < now ? 1 : 0;
        const pb = Date.parse(b.event.endsAt) < now ? 1 : 0;
        return pa - pb || (pa ? b.event.startsAt.localeCompare(a.event.startsAt) : a.event.startsAt.localeCompare(b.event.startsAt));
      });
    return json({ items });
  }),

  // ---------------- Liste d'attente ----------------
  route('post', '/events/:eventId/ticket-types/:ticketTypeId/waitlist', async ({ request, params }) => {
    const user = currentUser(request);
    requireVerified(user);
    expireDueOrders();
    const event = mock.db.events.find((e) => e.id === param(params, 'eventId') && e.status === 'PUBLISHED');
    const tt = event && mock.db.ticketTypes.find((t) => t.id === param(params, 'ticketTypeId') && t.eventId === event.id);
    if (!event || !tt) return notFound();
    const rules = effectiveRules(mock.db, event);
    const v = await readBody(request, ['quantity']);
    const quantity = v.int('quantity', { min: 1 });
    v.done();
    if (!rules.waitlistEnabled) fail(409, 'CONFLICT', 'Liste d’attente désactivée');
    if ((quantity ?? 0) > rules.maxPerOrder) fail(422, 'LIMIT_EXCEEDED', 'Plafond', { max: rules.maxPerOrder });
    if (remaining(tt) > 0) fail(409, 'NOT_SOLD_OUT', 'Places disponibles');
    if (mock.db.waitlist.some((w) => w.userId === user.id && w.ticketTypeId === tt.id && (w.status === 'WAITING' || w.status === 'OFFERED'))) {
      fail(409, 'ALREADY_IN_WAITLIST', 'Déjà inscrit');
    }
    const entry = { id: crypto.randomUUID(), userId: user.id, eventId: event.id, ticketTypeId: tt.id, quantity: quantity ?? 1, status: 'WAITING' as const, offerExpiresAt: null, createdAt: new Date().toISOString() };
    mock.db.waitlist.push(entry);
    return json(toWaitlist(entry), 201);
  }),

  route('get', '/me/waitlist', ({ request }) => {
    const user = currentUser(request);
    expireDueOrders();
    return json({ items: mock.db.waitlist.filter((w) => w.userId === user.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(toWaitlist) });
  }),

  route('delete', '/waitlist/:entryId', ({ request, params }) => {
    const user = currentUser(request);
    expireDueOrders();
    const w = mock.db.waitlist.find((x) => x.id === param(params, 'entryId') && x.userId === user.id);
    if (!w) return notFound();
    if (w.status !== 'WAITING' && w.status !== 'OFFERED') fail(409, 'INVALID_STATE', 'Entrée inactive');
    const wasOffered = w.status === 'OFFERED';
    w.status = 'LEFT';
    if (wasOffered) {
      const tt = mock.db.ticketTypes.find((t) => t.id === w.ticketTypeId);
      if (tt) tt.held -= w.quantity;
    }
    return noContent();
  }),

  route('post', '/waitlist/:entryId/accept', ({ request, params }) => {
    const user = currentUser(request);
    expireDueOrders();
    const w = mock.db.waitlist.find((x) => x.id === param(params, 'entryId') && x.userId === user.id);
    if (!w) return notFound();
    if (w.status === 'EXPIRED') fail(409, 'OFFER_EXPIRED', 'Offre expirée');
    if (w.status !== 'OFFERED') fail(409, 'INVALID_STATE', 'Pas d’offre en cours');
    const event = mock.db.events.find((e) => e.id === w.eventId);
    const tt = mock.db.ticketTypes.find((t) => t.id === w.ticketTypeId);
    if (!event || !tt) return notFound();
    const rules = effectiveRules(mock.db, event);
    const now = Date.now();
    const unit = currentPrice(tt, now).cents;
    const subtotal = unit * w.quantity;
    const fee = serviceFee(subtotal, rules);
    const order: MockOrder = {
      id: crypto.randomUUID(),
      userId: user.id,
      eventId: event.id,
      status: 'PENDING_PAYMENT',
      paymentMethod: 'CARD',
      items: [{ ticketTypeId: tt.id, name: tt.name, quantity: w.quantity, unitPriceCents: unit }],
      subtotalCents: subtotal,
      serviceFeeCents: fee,
      totalCents: subtotal + fee,
      expiresAt: new Date(now + holdDurations(event.id).cardMs).toISOString(),
      paidAt: null,
      cancellableUntil: rules.selfCancellationEnabled ? new Date(Date.parse(event.startsAt) - rules.cancellationDeadlineHours * 3_600_000).toISOString() : null,
      refundPercent: rules.refundPercent,
      serviceFeeRefundable: mock.db.settings.get(event.orgId)?.serviceFeeRefundable ?? false,
      refundAmountCents: null,
      createdAt: new Date(now).toISOString(),
      transferReference: null,
      idempotencyKey: crypto.randomUUID(),
      bodyFingerprint: `waitlist:${w.id}`,
    };
    w.status = 'CONVERTED';
    mock.db.orders.push(order); // les places restent `held`, transférées de l'offre à la commande
    return json(toOrder(order), 201);
  }),
];
