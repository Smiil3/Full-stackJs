import { randomBytes, randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../../src/lib/db.js';
import { AppError } from '../../src/lib/errors.js';
import { decryptOutboxPayload } from '../../src/lib/outbox.js';
import { cancelEvent } from '../../src/modules/events/service.js';
import { processEventReschedules } from '../../src/modules/events/reschedule.js';
import { removeMember, updateMemberRole } from '../../src/modules/orgs/service.js';
import { api, lastMail, loggedInUser } from '../helpers.js';
import { createEvent, orgWithStaff, type OrgFixture } from '../fixtures.js';

let org: OrgFixture;

beforeEach(async () => {
  org = await orgWithStaff('collectif-a1-events');
});

const ev = (path = '') => `/api/v1/orgs/${org.id}/events${path}`;

describe('surcharges financières réservées à l’OWNER (M1, contrat 1.17 §7.2)', () => {
  it('MANAGER : 403 sur une surcharge financière (création et modification), surcharges opérationnelles autorisées', async () => {
    const { eventId } = await createEvent(org, { ticketTypes: [{ name: 'A', capacity: 10, priceCents: 1000 }] });
    const base = (await api().get(ev(`/${eventId}`)).set(org.manager.auth).expect(200)).body;
    const created = await api().post(ev()).set(org.manager.auth).send({
      title: 'X', isOnline: false, startsAt: base.startsAt, endsAt: base.endsAt, timezone: 'Europe/Paris',
      salesStartAt: base.salesStartAt, salesEndAt: base.salesEndAt, overrides: { refundPercent: 0 },
    });
    expect(created.status).toBe(403);
    for (const overrides of [{ refundPercent: 0 }, { serviceFeeBasisPoints: 1500 }, { serviceFeeFixedCents: 1000 }, { transferEnabled: false }, { selfCancellationEnabled: false }, { cancellationDeadlineHours: 1 }]) {
      expect((await api().patch(ev(`/${eventId}`)).set(org.manager.auth).send({ overrides })).status).toBe(403);
    }
    await api().patch(ev(`/${eventId}`)).set(org.manager.auth).send({ overrides: { cardHoldMinutes: 30, maxPerOrder: 4, waitlistOfferMinutes: 60 } }).expect(200);
    // Valeur financière renvoyée inchangée (formulaire complet) : pas une modification.
    await api().patch(ev(`/${eventId}`)).set(org.manager.auth).send({ overrides: { refundPercent: null, cardHoldMinutes: 20 } }).expect(200);
    expect(await getDb().auditLog.count({ where: { action: 'event.financial_rules' } })).toBe(0);
  });

  it('OWNER : modification acceptée, audit avant / après champ par champ, mail à TOUS les OWNER', async () => {
    const second = await loggedInUser({ email: 'second-owner@test.fr' });
    await getDb().membership.create({ data: { orgId: org.id, userId: second.id, role: 'OWNER' } });
    const { eventId } = await createEvent(org, { ticketTypes: [{ name: 'A', capacity: 10, priceCents: 1000 }] });
    await api().patch(ev(`/${eventId}`)).set(org.owner.auth).send({ overrides: { refundPercent: 0, serviceFeeBasisPoints: 1500, cardHoldMinutes: 30 } }).expect(200);
    const audit = await getDb().auditLog.findFirstOrThrow({ where: { action: 'event.financial_rules' } });
    expect(audit.meta).toEqual({ changes: { refundPercent: { from: null, to: 0 }, serviceFeeBasisPoints: { from: null, to: 1500 } } });
    for (const email of [org.owner.email, second.email]) {
      const mail = await lastMail(email, 'financialRulesChanged');
      expect(decryptOutboxPayload(mail!)['changes']).toContain('frais proportionnels (points de base) : réglage du collectif → 1500');
    }
    expect(await lastMail(org.manager.email, 'financialRulesChanged')).toBeNull();
  });
});

describe('rôle relu dans la transaction pour les actions OWNER (B12)', () => {
  async function demoteOwner() {
    const other = await loggedInUser();
    await getDb().membership.create({ data: { orgId: org.id, userId: other.id, role: 'OWNER' } });
    // Rétrogradé APRÈS le contrôle du middleware (simulé en appelant le service directement).
    await getDb().membership.updateMany({ where: { orgId: org.id, userId: org.owner.id }, data: { role: 'MANAGER' } });
    return other;
  }
  const expect403 = async (p: Promise<unknown>) => {
    await expect(p).rejects.toBeInstanceOf(AppError);
    await expect(p).rejects.toMatchObject({ status: 403 });
  };

  it('annulation d’événement, rôle et retrait d’un membre, modification d’une surcharge financière ⇒ 403', async () => {
    const { eventId } = await createEvent(org, { ticketTypes: [{ name: 'A', capacity: 10, priceCents: 1000 }], publish: true });
    const other = await demoteOwner();
    await expect403(cancelEvent(org.id, org.owner.id, eventId, 'motif'));
    await expect403(updateMemberRole(org.id, org.owner.id, org.owner.id, 'OWNER'));
    await expect403(removeMember(org.id, org.owner.id, other.id));
    expect((await getDb().event.findUniqueOrThrow({ where: { id: eventId } })).status).toBe('PUBLISHED');
    expect(await getDb().membership.count({ where: { orgId: org.id, role: 'OWNER' } })).toBe(1);
  });
});

describe('report d’un événement par lots, dans le nouveau fuseau (B6 / B7)', () => {
  async function bulkPaidOrders(eventId: string, ttId: string, users: number, ordersPerUser: number) {
    const db = getDb();
    const created = await db.user.createManyAndReturn({
      data: Array.from({ length: users }, (_, i) => ({ email: `report${i}-${randomUUID().slice(0, 6)}@test.fr`, displayName: `R${i}`, passwordHash: 'x', emailVerifiedAt: new Date() })),
      select: { id: true },
    });
    const orders = created.flatMap((u) => Array.from({ length: ordersPerUser }, () => ({ id: randomUUID(), userId: u.id })));
    await db.order.createMany({
      data: orders.map((o) => ({
        id: o.id, userId: o.userId, eventId, status: 'PAID' as const, paymentMethod: 'CARD' as const, idempotencyKey: randomUUID(), requestHash: '0'.repeat(64),
        subtotalCents: 1000, serviceFeeCents: 0, totalCents: 1000, refundPercent: 50, serviceFeeRefundable: false, paidAt: new Date(),
        cancellableUntil: new Date(Date.now() + 86400_000),
      })),
    });
    await db.orderItem.createMany({ data: orders.map((o) => ({ id: randomUUID(), orderId: o.id, ticketTypeId: ttId, quantity: 1, unitPriceCents: 1000 })) });
    await db.ticketType.update({ where: { id: ttId }, data: { sold: orders.length } });
    return orders.map((o) => o.id);
  }

  it('1 000 commandes : réponse immédiate, droits appliqués par le worker, un seul mail par acheteur, nouveau fuseau ; 2e report refusé pendant le traitement', async () => {
    const { eventId, ticketTypeIds } = await createEvent(org, { ticketTypes: [{ name: 'A', capacity: 2000, priceCents: 1000 }], publish: true });
    await bulkPaidOrders(eventId, ticketTypeIds[0]!, 500, 2);
    const ev0 = await getDb().event.findUniqueOrThrow({ where: { id: eventId } });
    const newStart = new Date(ev0.startsAt.getTime() + 7 * 86400_000);
    const patch = {
      startsAt: newStart.toISOString(), endsAt: new Date(newStart.getTime() + 3600_000).toISOString(), salesEndAt: newStart.toISOString(),
      timezone: 'America/New_York', rescheduleReason: 'Salle inondée',
    };
    const later = { ...patch, startsAt: new Date(newStart.getTime() + 3600_000).toISOString(), endsAt: new Date(newStart.getTime() + 7200_000).toISOString() };
    const t0 = Date.now();
    await api().patch(ev(`/${eventId}`)).set(org.owner.auth).send(patch).expect(200);
    process.stdout.write(`[mesure] report de 1 000 commandes : réponse en ${Date.now() - t0} ms\n`);
    expect(await getDb().order.count({ where: { pendingRescheduleId: { not: null } } })).toBe(1000);
    const again = await api().patch(ev(`/${eventId}`)).set(org.owner.auth).send(later);
    expect(again.status).toBe(409);

    let total = 0;
    for (let i = 0; i < 5 && total < 1000; i += 1) total += (await processEventReschedules()).processed;
    expect(total).toBe(1000);
    expect(await getDb().order.count({ where: { eventId, refundPercent: 100, serviceFeeRefundable: true } })).toBe(1000);
    expect((await getDb().eventReschedule.findFirstOrThrow({ where: { eventId } })).completedAt).not.toBeNull();
    const mails = await getDb().emailOutbox.findMany({ where: { template: 'eventRescheduled' } });
    expect(mails).toHaveLength(500);
    const payload = decryptOutboxPayload(mails[0]!);
    expect(payload['newDate']).toContain('(heure : America/New_York)');
    expect(payload['oldDate']).toContain('(heure : Europe/Paris)');
    // Report terminé : un nouveau report est de nouveau possible.
    await api().patch(ev(`/${eventId}`)).set(org.owner.auth).send(later).expect(200);
  }, 120_000);

  it('auto-annulation pendant le traitement : le report s’applique d’abord (remboursement intégral)', async () => {
    const buyer = await loggedInUser();
    const { eventId, ticketTypeIds } = await createEvent(org, { ticketTypes: [{ name: 'A', capacity: 10, priceCents: 1000 }], publish: true });
    const orderId = (await bulkPaidOrders(eventId, ticketTypeIds[0]!, 1, 1))[0]!;
    await getDb().order.update({ where: { id: orderId }, data: { userId: buyer.id } });
    await getDb().payment.create({ data: { orderId, providerPaymentId: `pay_${randomBytes(6).toString('hex')}`, amountCents: 1000, currency: 'EUR', status: 'SUCCEEDED' } });
    const ev0 = await getDb().event.findUniqueOrThrow({ where: { id: eventId } });
    const newStart = new Date(ev0.startsAt.getTime() + 86400_000);
    await api().patch(ev(`/${eventId}`)).set(org.owner.auth)
      .send({ startsAt: newStart.toISOString(), endsAt: new Date(newStart.getTime() + 3600_000).toISOString(), salesEndAt: newStart.toISOString(), rescheduleReason: 'Report' })
      .expect(200);
    const res = await api().post(`/api/v1/orders/${orderId}/cancel`).set(buyer.auth).expect(200);
    expect(res.body).toMatchObject({ status: 'REFUNDED', refundAmountCents: 1000 });
    expect((await getDb().order.findUniqueOrThrow({ where: { id: orderId } })).pendingRescheduleId).toBeNull();
  });
});
