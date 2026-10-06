import { randomUUID } from 'node:crypto';
import type { Order } from '../../generated/prisma/client.js';
import { getEnv } from '../../config/env.js';
import { clock } from '../../lib/clock.js';
import { safeEqual, sha256Hex, transferReference } from '../../lib/crypto.js';
import { bankCrypto } from '../../lib/bankCrypto.js';
import { getLogger } from '../../lib/logger.js';
import { transaction, type Tx } from '../../lib/db.js';
import { errors } from '../../lib/errors.js';
import { formatEuros } from '../../lib/mail/templates.js';
import { computeServiceFee, lineTotal } from '../../lib/money.js';
import { enqueueEmail } from '../../lib/outbox.js';
import { priceAt } from '../../lib/pricing.js';
import { iso } from '../../lib/schemas.js';
import { addHours, addMinutes, formatWithZone } from '../../lib/time.js';
import { resolveEventSettings } from '../settings/resolveEventSettings.js';
import { getPspClient } from '../../lib/psp.js';
import { issueTickets } from '../tickets/issue.js';
import { refundPreview } from './refund.js';
import * as repo from './repo.js';
import type { CreateOrderBody } from './schemas.js';

type Viewer = 'owner' | 'admin';

/** Représentation contractuelle d'une commande (jamais l'objet Prisma brut). */
export function toOrderView(order: repo.OrderWithDetails, scanned: number, viewer: Viewer, now: Date = clock.now()) {
  let transferInstructions = null;
  if (order.status === 'AWAITING_TRANSFER' && order.transferReference && order.transferIbanEncrypted && order.expiresAt) {
    transferInstructions = {
      beneficiary: order.transferBeneficiary ?? '',
      // IBAN en clair uniquement pour l'acheteur concerné ; masqué pour le back-office (contrat 1.2).
      iban: viewer === 'owner'
        ? bankCrypto.decryptOrderIban(order.id, order.transferIbanEncrypted)
        : (order.transferIbanMasked ?? ''),
      bic: order.transferBic ?? '',
      reference: order.transferReference,
      amountCents: order.totalCents,
      deadline: iso(order.expiresAt),
    };
  }
  return {
    id: order.id,
    eventId: order.eventId,
    eventTitle: order.event.title,
    eventStartsAt: iso(order.event.startsAt),
    eventTimezone: order.event.timezone,
    status: order.status,
    paymentMethod: order.paymentMethod,
    items: order.items.map((i) => ({ ticketTypeId: i.ticketTypeId, name: i.ticketType.name, quantity: i.quantity, unitPriceCents: i.unitPriceCents })),
    subtotalCents: order.subtotalCents,
    serviceFeeCents: order.serviceFeeCents,
    totalCents: order.totalCents,
    currency: 'EUR' as const,
    expiresAt: iso(order.expiresAt),
    paidAt: iso(order.paidAt),
    cancellableUntil: iso(order.cancellableUntil),
    refundPercent: order.refundPercent,
    refundAmountCents: order.refundAmountCents,
    refundPreviewCents: refundPreview({ ...order, eventStartsAt: order.event.startsAt, scannedTickets: scanned }, now),
    createdAt: iso(order.createdAt),
    transferInstructions,
  };
}

export async function viewOwnOrder(tx: Tx, userId: string, orderId: string, viewer: Viewer = 'owner') {
  const order = await repo.findOwnOrder(tx, userId, orderId);
  if (!order) throw errors.notFound();
  const scanned = await repo.scannedCounts(tx, [order.id]);
  return toOrderView(order, scanned.get(order.id) ?? 0, viewer);
}

/** Empreinte canonique du corps (items triés) : même clé + corps différent ⇒ IDEMPOTENCY_CONFLICT. */
export function requestHash(body: CreateOrderBody): string {
  const items = [...body.items].sort((a, b) => a.ticketTypeId.localeCompare(b.ticketTypeId)).map((i) => [i.ticketTypeId, i.quantity]);
  return sha256Hex(JSON.stringify({ eventId: body.eventId, paymentMethod: body.paymentMethod, items }));
}

type CreateResult = { replayed: boolean; order: ReturnType<typeof toOrderView> };

async function replay(tx: Tx, existing: Order, hash: string, userId: string): Promise<CreateResult> {
  if (!safeEqual(existing.requestHash, hash)) {
    throw errors.state('IDEMPOTENCY_CONFLICT', 'Cette clé d’idempotence a déjà servi pour une autre commande.');
  }
  return { replayed: true, order: await viewOwnOrder(tx, userId, existing.id) };
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === 'P2002';
}

/**
 * Réservation : tout est calculé côté serveur (prix, early, frais, total, échéances) et figé sur la commande.
 * - verrou (acheteur, événement) ⇒ plafond par personne exact même avec des requêtes parallèles ;
 * - réservation par UPDATE conditionnel, types triés par id (pas d'interblocage) ;
 * - commande à 0 € ⇒ PAID immédiatement (mêmes règles : ventes ouvertes, plafonds, idempotence).
 */
export async function createOrder(userId: string, idempotencyKey: string, body: CreateOrderBody): Promise<CreateResult> {
  const hash = requestHash(body);
  try {
    return await transaction(async (tx) => {
      await repo.lockBuyerEvent(tx, userId, body.eventId);
      const existing = await tx.order.findUnique({ where: { userId_idempotencyKey: { userId, idempotencyKey } } });
      if (existing) return replay(tx, existing, hash, userId);
      return { replayed: false, order: await reserveAndCreate(tx, userId, idempotencyKey, hash, body) };
    });
  } catch (err) {
    // Même clé envoyée en parallèle pour deux événements différents : la contrainte unique tranche.
    if (!isUniqueViolation(err)) throw err;
    return transaction(async (tx) => {
      const existing = await tx.order.findUnique({ where: { userId_idempotencyKey: { userId, idempotencyKey } } });
      if (!existing) throw err;
      return replay(tx, existing, hash, userId);
    });
  }
}

async function reserveAndCreate(tx: Tx, userId: string, idempotencyKey: string, hash: string, body: CreateOrderBody) {
  const now = clock.now();
  const event = await tx.event.findUnique({
    where: { id: body.eventId },
    include: { ticketTypes: true, organization: { select: { name: true, settings: true } } },
  });
  if (!event || event.status === 'DRAFT' || !event.organization.settings) throw errors.notFound();
  if (event.status !== 'PUBLISHED' || now < event.salesStartAt || now >= event.salesEndAt || now >= event.startsAt) {
    throw errors.state('SALES_CLOSED', 'Les ventes ne sont pas ouvertes pour cet événement.');
  }
  const settings = event.organization.settings;
  const rules = resolveEventSettings(settings, event);
  const typesById = new Map(event.ticketTypes.map((t) => [t.id, t]));
  const items = [...body.items].sort((a, b) => a.ticketTypeId.localeCompare(b.ticketTypeId));
  for (const item of items) if (!typesById.has(item.ticketTypeId)) throw errors.notFound();

  if (body.paymentMethod === 'TRANSFER' && !(rules.transferEnabled && rules.bankConfigured)) {
    throw errors.unprocessable('PAYMENT_METHOD_UNAVAILABLE', 'Le paiement par virement n’est pas disponible pour cet événement.');
  }
  const quantity = items.reduce((n, i) => n + i.quantity, 0);
  const owned = await repo.alreadyOwned(tx, userId, event.id);
  if (quantity > rules.maxPerOrder) {
    throw errors.unprocessable('LIMIT_EXCEEDED', `Au plus ${rules.maxPerOrder} place(s) par commande.`, { max: rules.maxPerOrder, alreadyOwned: owned });
  }
  if (owned + quantity > rules.maxPerUser) {
    throw errors.unprocessable('LIMIT_EXCEEDED', `Au plus ${rules.maxPerUser} place(s) par personne pour cet événement.`, { max: rules.maxPerUser, alreadyOwned: owned });
  }

  for (const item of items) {
    if (!(await repo.reserve(tx, event.id, item.ticketTypeId, item.quantity))) {
      throw errors.state('SOLD_OUT', 'Plus assez de places disponibles.', { ticketTypeId: item.ticketTypeId });
    }
  }

  const lines = items.map((i) => {
    const tt = typesById.get(i.ticketTypeId);
    if (!tt) throw errors.notFound();
    return { ticketTypeId: i.ticketTypeId, quantity: i.quantity, unitPriceCents: priceAt(tt, now).unitPriceCents };
  });
  const subtotalCents = lines.reduce((sum, l) => sum + lineTotal(l.unitPriceCents, l.quantity), 0);
  const serviceFeeCents = computeServiceFee(subtotalCents, rules.serviceFeeFixedCents, rules.serviceFeeBasisPoints);
  const totalCents = subtotalCents + serviceFeeCents;
  const free = totalCents === 0;
  const orderId = randomUUID();

  // Échéance de paiement, jamais au-delà du début de l'événement.
  const hold = body.paymentMethod === 'CARD' ? addMinutes(now, rules.cardHoldMinutes) : addHours(now, rules.transferHoldHours);
  const expiresAt = free ? null : new Date(Math.min(hold.getTime(), event.startsAt.getTime()));

  let transfer = {};
  let ibanPlain: string | null = null;
  if (!free && body.paymentMethod === 'TRANSFER' && settings.bankIbanEncrypted) {
    try {
      ibanPlain = bankCrypto.decryptOrgIban(event.orgId, settings.bankIbanEncrypted);
    } catch (err) {
      // Coordonnées illisibles (donnée corrompue, clé retirée du trousseau…) : virement indisponible, alerte journalisée.
      getLogger().error({ err, orgId: event.orgId }, 'IBAN du collectif indéchiffrable : virement indisponible');
      throw errors.unprocessable('PAYMENT_METHOD_UNAVAILABLE', 'Le paiement par virement n’est pas disponible pour cet événement.');
    }
    transfer = {
      transferReference: transferReference(),
      transferBeneficiary: settings.bankBeneficiary,
      transferIbanEncrypted: bankCrypto.encryptOrderIban(orderId, ibanPlain),
      transferIbanMasked: settings.bankIbanMasked,
      transferBic: settings.bankBic,
    };
  }

  const order = await tx.order.create({
    data: {
      id: orderId,
      userId,
      eventId: event.id,
      status: free ? 'PAID' : body.paymentMethod === 'CARD' ? 'PENDING_PAYMENT' : 'AWAITING_TRANSFER',
      paymentMethod: body.paymentMethod,
      idempotencyKey,
      requestHash: hash,
      subtotalCents,
      serviceFeeCents,
      totalCents,
      refundPercent: rules.refundPercent,
      serviceFeeRefundable: rules.serviceFeeRefundable,
      cancellableUntil: rules.selfCancellationEnabled ? addHours(event.startsAt, -rules.cancellationDeadlineHours) : null,
      expiresAt,
      paidAt: free ? now : null,
      ...transfer,
      items: { create: lines },
    },
    include: { user: { select: { email: true, displayName: true } } },
  });

  if (free) {
    for (const l of lines) await repo.heldToSold(tx, event.id, l.ticketTypeId, l.quantity);
    await issueTickets(tx, order.id);
    await enqueueEmail(tx, order.user.email, 'orderConfirmed', {
      displayName: order.user.displayName,
      orderId: order.id,
      eventTitle: event.title,
      eventDate: formatWithZone(event.startsAt, event.timezone),
      ticketsLink: `${getEnv().frontUrl}/me/tickets`,
    });
  } else if (ibanPlain && order.transferReference && expiresAt) {
    await enqueueEmail(tx, order.user.email, 'transferInstructions', {
      displayName: order.user.displayName,
      eventTitle: event.title,
      amount: formatEuros(totalCents),
      reference: order.transferReference,
      beneficiary: settings.bankBeneficiary ?? '',
      iban: ibanPlain,
      bic: settings.bankBic ?? '',
      deadline: formatWithZone(expiresAt, event.timezone),
    });
  }
  return viewOwnOrder(tx, userId, order.id);
}

export async function listOrders(userId: string, page: number, pageSize: number) {
  const [rows, total] = await repo.listOwnOrders(userId, page, pageSize);
  const scanned = await transaction((tx) => repo.scannedCounts(tx, rows.map((o) => o.id)));
  const now = clock.now();
  return { items: rows.map((o) => toOrderView(o, scanned.get(o.id) ?? 0, 'owner', now)), page, pageSize, total };
}

export function getOrder(userId: string, orderId: string) {
  return transaction((tx) => viewOwnOrder(tx, userId, orderId));
}

/**
 * Démarre (ou reprend) le paiement par carte. Idempotent : une session PSP déjà ouverte pour la commande
 * est réutilisée ; deux appels concurrents obtiennent la même session (clé d'idempotence PSP = id de commande).
 * L'appel au PSP se fait hors transaction.
 */
export async function checkout(userId: string, orderId: string): Promise<{ redirectUrl: string }> {
  const order = await transaction((tx) => repo.findOwnOrder(tx, userId, orderId));
  if (!order) throw errors.notFound();
  const now = clock.now();
  const expired = order.status === 'EXPIRED' || (order.status === 'PENDING_PAYMENT' && order.expiresAt !== null && order.expiresAt <= now);
  if (expired) throw errors.state('ORDER_EXPIRED', 'La réservation a expiré.');
  if (order.status !== 'PENDING_PAYMENT' || order.paymentMethod !== 'CARD') {
    throw errors.state('INVALID_STATE', 'Cette commande ne peut pas être payée par carte.');
  }
  if (order.pspSessionUrl) return { redirectUrl: order.pspSessionUrl };
  const env = getEnv();
  const session = await getPspClient().createCheckoutSession({
    orderId: order.id,
    amountCents: order.totalCents,
    currency: 'EUR',
    successUrl: `${env.frontUrl}/orders/${order.id}?payment=success`,
    cancelUrl: `${env.frontUrl}/orders/${order.id}?payment=failed`,
    idempotencyKey: order.id,
  });
  return transaction(async (tx) => {
    const { count } = await tx.order.updateMany({
      where: { id: order.id, userId, status: 'PENDING_PAYMENT', pspSessionUrl: null },
      data: { pspSessionId: session.id, pspSessionUrl: session.url },
    });
    if (count === 1) return { redirectUrl: session.url };
    // Appel concurrent déjà enregistré : on renvoie la session stockée.
    const current = await tx.order.findFirst({ where: { id: order.id, userId }, select: { status: true, pspSessionUrl: true } });
    if (current?.status === 'PENDING_PAYMENT' && current.pspSessionUrl) return { redirectUrl: current.pspSessionUrl };
    throw errors.state('INVALID_STATE', 'La commande a changé d’état entre-temps.');
  });
}
