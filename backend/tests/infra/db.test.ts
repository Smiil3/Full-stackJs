import { describe, expect, it } from 'vitest';
import { getDb } from '../../src/lib/db.js';
import { TRUNCATED_TABLES } from '../setup/db.js';

describe('base de données', () => {
  it('le nettoyage entre tests couvre toutes les tables', async () => {
    const rows = await getDb().$queryRaw<{ tablename: string }[]>`
      SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations' ORDER BY tablename`;
    expect(rows.map((r) => r.tablename)).toEqual([...TRUNCATED_TABLES].sort());
  });

  it('la contrainte CHECK interdit sold + held > capacity', async () => {
    const db = getDb();
    const org = await db.organization.create({ data: { name: 'Org', slug: 'org-check' } });
    const event = await db.event.create({
      data: {
        orgId: org.id, title: 'E', startsAt: new Date('2030-01-01T20:00:00Z'), endsAt: new Date('2030-01-01T23:00:00Z'),
        timezone: 'Europe/Paris', salesStartAt: new Date('2029-01-01T00:00:00Z'), salesEndAt: new Date('2030-01-01T20:00:00Z'),
      },
    });
    const tt = await db.ticketType.create({ data: { eventId: event.id, name: 'Fosse', capacity: 10, priceCents: 1000 } });
    await expect(db.ticketType.update({ where: { id: tt.id }, data: { sold: 6, held: 5 } })).rejects.toThrow();
    await expect(db.ticketType.update({ where: { id: tt.id }, data: { held: -1 } })).rejects.toThrow();
    await expect(db.ticketType.update({ where: { id: tt.id }, data: { sold: 6, held: 4 } })).resolves.toBeTruthy();
    // UPDATE SQL direct, sans aucune garde applicative : la base refuse la survente.
    await expect(db.$executeRaw`UPDATE "ticket_types" SET "sold" = "sold" + 1 WHERE "id" = ${tt.id}::uuid`).rejects.toThrow(/ticket_types_stock_check/);
    await expect(db.$executeRaw`UPDATE "ticket_types" SET "held" = "held" + 1 WHERE "id" = ${tt.id}::uuid`).rejects.toThrow(/ticket_types_stock_check/);
    const after = await db.ticketType.findUniqueOrThrow({ where: { id: tt.id } });
    expect(after.sold + after.held).toBe(10);
  });

  it('les contraintes CHECK protègent prix, early et quantités', async () => {
    const db = getDb();
    const org = await db.organization.create({ data: { name: 'Org', slug: 'org-prix' } });
    const event = await db.event.create({
      data: {
        orgId: org.id, title: 'E', startsAt: new Date('2030-01-01T20:00:00Z'), endsAt: new Date('2030-01-01T23:00:00Z'),
        timezone: 'Europe/Paris', salesStartAt: new Date('2029-01-01T00:00:00Z'), salesEndAt: new Date('2030-01-01T20:00:00Z'),
      },
    });
    const base = { eventId: event.id, name: 'T', capacity: 10, priceCents: 1000 };
    await expect(db.ticketType.create({ data: { ...base, capacity: 0 } })).rejects.toThrow();
    await expect(db.ticketType.create({ data: { ...base, priceCents: -1 } })).rejects.toThrow();
    await expect(db.ticketType.create({ data: { ...base, earlyPriceCents: 1000, earlyUntil: new Date() } })).rejects.toThrow();
    await expect(db.ticketType.create({ data: { ...base, earlyPriceCents: 500 } })).rejects.toThrow();
    // Dates incohérentes : fin avant début.
    await expect(db.event.update({ where: { id: event.id }, data: { endsAt: new Date('2029-12-31T00:00:00Z') } })).rejects.toThrow();
  });

  it('index unique partiel : une seule entrée active de liste d’attente par acheteur et type', async () => {
    const db = getDb();
    const org = await db.organization.create({ data: { name: 'Org', slug: 'org-wl' } });
    const user = await db.user.create({ data: { email: 'a@test.fr', passwordHash: 'x', displayName: 'A' } });
    const event = await db.event.create({
      data: {
        orgId: org.id, title: 'E', startsAt: new Date('2030-01-01T20:00:00Z'), endsAt: new Date('2030-01-01T23:00:00Z'),
        timezone: 'Europe/Paris', salesStartAt: new Date('2029-01-01T00:00:00Z'), salesEndAt: new Date('2030-01-01T20:00:00Z'),
      },
    });
    const tt = await db.ticketType.create({ data: { eventId: event.id, name: 'Fosse', capacity: 10, priceCents: 1000 } });
    const base = { ticketTypeId: tt.id, eventId: event.id, userId: user.id, quantity: 1 };
    await db.waitlistEntry.create({ data: { ...base, status: 'LEFT' } });
    await db.waitlistEntry.create({ data: base });
    await expect(db.waitlistEntry.create({ data: base })).rejects.toThrow();
  });
});

describe('chiffrement des IBAN en base (B1.1 H3)', () => {
  it('un IBAN chiffré copié vers la ligne d’un autre collectif ne se déchiffre pas', async () => {
    const { getEnv } = await import('../../src/config/env.js');
    const { aad, decryptString, encryptString } = await import('../../src/lib/crypto.js');
    const db = getDb();
    const keyring = getEnv().dataKeyring;
    const a = await db.organization.create({ data: { name: 'A', slug: 'org-a' } });
    const b = await db.organization.create({ data: { name: 'B', slug: 'org-b' } });
    const encA = encryptString('FR7630006000011234567890189', keyring, aad.orgBankIban(a.id));
    await db.organizationSettings.create({ data: { orgId: a.id, bankIbanEncrypted: encA } });
    // Attaquant avec accès en écriture à la base : recopie le chiffré de A sur B.
    await db.organizationSettings.create({ data: { orgId: b.id, bankIbanEncrypted: encA } });
    const rowB = await db.organizationSettings.findUniqueOrThrow({ where: { orgId: b.id } });
    expect(() => decryptString(rowB.bankIbanEncrypted!, keyring, aad.orgBankIban(b.id))).toThrow();
    const rowA = await db.organizationSettings.findUniqueOrThrow({ where: { orgId: a.id } });
    expect(decryptString(rowA.bankIbanEncrypted!, keyring, aad.orgBankIban(a.id))).toBe('FR7630006000011234567890189');
  });
});

describe('intégrité des paiements et remboursements (B1.1 B5)', () => {
  async function paidOrder() {
    const db = getDb();
    const org = await db.organization.create({ data: { name: 'Org', slug: `org-${Date.now()}` } });
    const user = await db.user.create({ data: { email: `p${Date.now()}@test.fr`, passwordHash: 'x', displayName: 'P' } });
    const event = await db.event.create({
      data: {
        orgId: org.id, title: 'E', startsAt: new Date('2030-01-01T20:00:00Z'), endsAt: new Date('2030-01-01T23:00:00Z'),
        timezone: 'Europe/Paris', salesStartAt: new Date('2029-01-01T00:00:00Z'), salesEndAt: new Date('2030-01-01T20:00:00Z'),
      },
    });
    const order = await db.order.create({
      data: {
        userId: user.id, eventId: event.id, status: 'PAID', paymentMethod: 'CARD', idempotencyKey: '11111111-1111-4111-8111-111111111111',
        requestHash: '0'.repeat(64), subtotalCents: 3000, serviceFeeCents: 0, totalCents: 3000, refundPercent: 100, serviceFeeRefundable: false,
      },
    });
    const payment = await db.payment.create({ data: { orderId: order.id, providerPaymentId: `pay_${Date.now()}`, amountCents: 3000, currency: 'EUR', status: 'SUCCEEDED' } });
    return { order, payment };
  }

  it('la somme des remboursements ne peut pas dépasser le paiement', async () => {
    const db = getDb();
    const { order, payment } = await paidOrder();
    const base = { orderId: order.id, paymentId: payment.id, reason: 'TEST' };
    await db.refund.create({ data: { ...base, amountCents: 2000 } });
    await expect(db.refund.create({ data: { ...base, amountCents: 1001 } })).rejects.toThrow();
    await db.refund.create({ data: { ...base, amountCents: 1000 } });
    // Un remboursement échoué ne compte pas.
    await db.refund.create({ data: { ...base, amountCents: 500, status: 'FAILED' } });
    await expect(db.refund.create({ data: { ...base, amountCents: 1 } })).rejects.toThrow();
  });

  it('remboursements concurrents : jamais plus que le montant payé', async () => {
    const db = getDb();
    const { order, payment } = await paidOrder();
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () => db.refund.create({ data: { orderId: order.id, paymentId: payment.id, reason: 'TEST', amountCents: 1000 } })),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(3);
    const sum = await db.refund.aggregate({ where: { paymentId: payment.id }, _sum: { amountCents: true } });
    expect(sum._sum.amountCents).toBe(3000);
  });

  it('paiement dans une autre devise refusé', async () => {
    const db = getDb();
    const { order } = await paidOrder();
    await expect(db.payment.create({ data: { orderId: order.id, providerPaymentId: 'pay_usd', amountCents: 1, currency: 'USD', status: 'SUCCEEDED' } })).rejects.toThrow();
  });

  it('clés étrangères : replacedById et usedByUserId pointent sur des lignes existantes', async () => {
    const db = getDb();
    const user = await db.user.create({ data: { email: 'fk@test.fr', passwordHash: 'x', displayName: 'F' } });
    await expect(db.refreshToken.create({
      data: { userId: user.id, familyId: user.id, tokenHash: 'a'.repeat(64), expiresAt: new Date(), replacedById: '22222222-2222-4222-8222-222222222222' },
    })).rejects.toThrow();
  });
});
