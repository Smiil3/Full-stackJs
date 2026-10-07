/**
 * Données de démonstration d'un acheteur (mode mock, serveur de dev uniquement) : une commande payée
 * avec ses billets, une commande en attente de virement et une offre de liste d'attente. Sert aux
 * captures d'écran et aux démonstrations ; jamais présent dans le build.
 */
import { mock } from './core';
import { holdDurations, markPaid, transferReference } from './domain';
import { currentPrice, effectiveRules, IDS, serviceFee, type MockOrder } from './state';

function order(userId: string, ticketTypeId: string, quantity: number, method: 'CARD' | 'TRANSFER'): MockOrder | null {
  const tt = mock.db.ticketTypes.find((t) => t.id === ticketTypeId);
  const event = tt ? mock.db.events.find((e) => e.id === tt.eventId) : undefined;
  if (!tt || !event) return null;
  const now = Date.now();
  const rules = effectiveRules(mock.db, event);
  const unit = currentPrice(tt, now).cents;
  const fee = serviceFee(unit * quantity, rules);
  const holds = holdDurations(event.id);
  tt.held += quantity;
  const o: MockOrder = {
    id: crypto.randomUUID(),
    userId,
    eventId: event.id,
    status: method === 'TRANSFER' ? 'AWAITING_TRANSFER' : 'PENDING_PAYMENT',
    paymentMethod: method,
    items: [{ ticketTypeId: tt.id, name: tt.name, quantity, unitPriceCents: unit }],
    subtotalCents: unit * quantity,
    serviceFeeCents: fee,
    totalCents: unit * quantity + fee,
    expiresAt: new Date(now + (method === 'TRANSFER' ? holds.transferMs : holds.cardMs)).toISOString(),
    paidAt: null,
    cancellableUntil: rules.selfCancellationEnabled ? new Date(Date.parse(event.startsAt) - rules.cancellationDeadlineHours * 3_600_000).toISOString() : null,
    refundPercent: rules.refundPercent,
    serviceFeeRefundable: mock.db.settings.get(event.orgId)?.serviceFeeRefundable ?? false,
    refundAmountCents: null,
    createdAt: new Date(now).toISOString(),
    transferReference: method === 'TRANSFER' ? transferReference() : null,
    idempotencyKey: crypto.randomUUID(),
    bodyFingerprint: `demo:${crypto.randomUUID()}`,
  };
  mock.db.orders.push(o);
  return o;
}

/** Prépare le compte acheteur de démonstration ; renvoie les identifiants utiles. */
export async function seedDemoBuyer(): Promise<{ paidOrderId: string; transferOrderId: string; waitlistId: string }> {
  const userId = IDS.userBuyer;
  const paid = order(userId, IDS.ttFosse, 2, 'CARD');
  if (paid) await markPaid(paid);
  const transfer = order(userId, IDS.ttBalcon, 1, 'TRANSFER');
  const tt = mock.db.ticketTypes.find((t) => t.id === IDS.ttSoldOut);
  const waitlistId = crypto.randomUUID();
  if (tt) {
    mock.db.waitlist.push({
      id: waitlistId,
      userId,
      eventId: tt.eventId,
      ticketTypeId: tt.id,
      quantity: 2,
      status: 'OFFERED',
      offerExpiresAt: new Date(Date.now() + 38 * 60_000).toISOString(),
      createdAt: new Date(Date.now() - 86_400_000).toISOString(),
    });
  }
  return { paidOrderId: paid?.id ?? '', transferOrderId: transfer?.id ?? '', waitlistId };
}
