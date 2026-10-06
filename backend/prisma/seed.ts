/**
 * Données de démonstration.
 * - Refuse de s'exécuter en production, sur une base non locale et sur une base déjà peuplée.
 * - Mot de passe des comptes : SEED_PASSWORD (≥ 16 caractères) ou mot de passe aléatoire affiché UNE fois.
 */
import 'dotenv/config';
import { randomBytes, randomUUID } from 'node:crypto';
import { hashPassword } from '../src/lib/password.js';
import { getEnv } from '../src/config/env.js';
import { disconnectDb, getDb } from '../src/lib/db.js';
import { aad, encryptString, randomToken, transferReference } from '../src/lib/crypto.js';
import { isValidIban, maskIban, normalizeIban } from '../src/lib/iban.js';
import { addHours, HOUR_MS } from '../src/lib/time.js';
import type { Role } from '../src/generated/prisma/client.js';
import { assertSeedAllowed } from './seedGuard.js';

const out = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

const DAY_MS = 24 * HOUR_MS;

async function main(): Promise<void> {
  const env = getEnv();
  const provided = process.env['SEED_PASSWORD'] ?? '';
  assertSeedAllowed({ nodeEnv: env.nodeEnv, databaseUrl: env.databaseUrl, seedPassword: provided });
  const db = getDb();
  if ((await db.user.count()) > 0) {
    out('Base déjà peuplée : seed ignoré (videz la base pour le rejouer : npx prisma migrate reset).');
    return;
  }

  const password = provided === '' ? randomToken(18) : provided;
  const passwordHash = await hashPassword(password);
  const now = new Date();

  const mkUser = (email: string, displayName: string, isPlatformAdmin = false) =>
    db.user.create({ data: { email, displayName, passwordHash, isPlatformAdmin, emailVerifiedAt: now } });

  const admin = await mkUser('admin@nuits-garonne.test', 'Admin Plateforme', true);
  const buyer = await mkUser('acheteur@nuits-garonne.test', 'Camille Acheteuse');

  const ibanPlain = normalizeIban('FR76 3000 6000 0112 3456 7890 189');
  if (!isValidIban(ibanPlain)) throw new Error('IBAN de démonstration invalide');

  const orgDefs = [
    { name: 'Les Nuits de la Garonne', slug: 'nuits-garonne', prefix: 'nuits' },
    { name: 'Collectif Rive Droite', slug: 'rive-droite', prefix: 'rivedroite' },
    { name: 'Les Chais Sonores', slug: 'chais-sonores', prefix: 'chais' },
  ];
  const orgs = [];
  for (const def of orgDefs) {
    const org = await db.organization.create({ data: { name: def.name, slug: def.slug } });
    await db.organizationSettings.create({
      data: {
        orgId: org.id,
        contactEmail: `contact@${def.slug}.test`,
        bankBeneficiary: def.name,
        bankIbanEncrypted: encryptString(ibanPlain, env.dataKeyring, aad.orgBankIban(org.id)),
        bankIbanMasked: maskIban(ibanPlain),
        bankBic: 'AGRIFRPP',
      },
    });
    const roles: [Role, string][] = [['OWNER', 'Proprio'], ['MANAGER', 'Gestion'], ['SCANNER', 'Scan']];
    for (const [role, label] of roles) {
      const user = await mkUser(`${role.toLowerCase()}@${def.prefix}.test`, `${label} ${def.name}`);
      await db.membership.create({ data: { userId: user.id, orgId: org.id, role } });
    }
    orgs.push(org);
  }
  const [nuits, riveDroite, chais] = orgs;
  if (!nuits || !riveDroite || !chais) throw new Error('organisations manquantes');

  const at = (days: number, hourUtc: number): Date => {
    const d = new Date(now.getTime() + days * DAY_MS);
    d.setUTCHours(hourUtc, 0, 0, 0);
    return d;
  };

  // 1. Événement avec tarif early (fin de l'early dans 10 jours).
  const electro = await db.event.create({
    data: {
      orgId: nuits.id, title: 'Nuit Électro sur les quais', status: 'PUBLISHED', timezone: 'Europe/Paris',
      description: 'Une nuit entière de musique électronique au bord de la Garonne.',
      venue: 'Hangar 14', address: 'Quai des Chartrons, 33000 Bordeaux',
      startsAt: at(45, 20), endsAt: at(46, 4), salesStartAt: addHours(now, -24), salesEndAt: at(45, 20),
      ticketTypes: {
        create: [
          { name: 'Fosse', capacity: 500, priceCents: 2500, earlyPriceCents: 1800, earlyUntil: at(10, 22), sortOrder: 0 },
          { name: 'Balcon', capacity: 100, priceCents: 3500, earlyPriceCents: 2900, earlyUntil: at(10, 22), sortOrder: 1 },
        ],
      },
    },
  });

  // 2. Événement en ligne, fuseau New York (participants à l'étranger).
  await db.event.create({
    data: {
      orgId: nuits.id, title: 'Live stream : Garonne Sessions', status: 'PUBLISHED', timezone: 'America/New_York',
      description: 'Concert retransmis en direct, pensé pour le public nord-américain.', isOnline: true,
      startsAt: at(30, 0), endsAt: at(30, 3), salesStartAt: addHours(now, -1), salesEndAt: at(30, 0),
      ticketTypes: {
        create: [
          { name: 'Accès streaming', capacity: 600, priceCents: 800, sortOrder: 0 },
          { name: 'Accès + replay', capacity: 200, priceCents: 1200, sortOrder: 1 },
        ],
      },
    },
  });

  // 3. Événement presque complet (38 / 40 places vendues en balcon) avec de vraies commandes payées.
  const jazz = await db.event.create({
    data: {
      orgId: nuits.id, title: 'Jazz au Hangar', status: 'PUBLISHED', timezone: 'Europe/Paris',
      venue: 'Le Hangar', address: '12 rue des Vignes, 33800 Bordeaux',
      startsAt: at(20, 19), endsAt: at(20, 23), salesStartAt: addHours(now, -72), salesEndAt: at(20, 19),
      ticketTypes: {
        create: [
          { name: 'Balcon', capacity: 40, priceCents: 2000, sortOrder: 0 },
          { name: 'Parterre', capacity: 120, priceCents: 1500, sortOrder: 1 },
        ],
      },
    },
    include: { ticketTypes: true },
  });
  const balcon = jazz.ticketTypes.find((t) => t.name === 'Balcon');
  if (!balcon) throw new Error('type Balcon manquant');
  for (let i = 1; i <= 19; i += 1) {
    const guest = await db.user.create({
      data: {
        email: `public${i}@nuits-garonne.test`, displayName: `Spectateur ${i}`, emailVerifiedAt: now,
        // Comptes de remplissage sans mot de passe connu.
        passwordHash: await hashPassword(randomToken(24)),
      },
    });
    await db.$transaction(async (tx) => {
      const order = await tx.order.create({
        data: {
          userId: guest.id, eventId: jazz.id, status: 'PAID', paymentMethod: 'CARD',
          idempotencyKey: randomUUID(), requestHash: '0'.repeat(64),
          subtotalCents: 4000, serviceFeeCents: 0, totalCents: 4000, refundPercent: 100, serviceFeeRefundable: false,
          cancellableUntil: addHours(jazz.startsAt, -48), paidAt: now,
          items: { create: [{ ticketTypeId: balcon.id, quantity: 2, unitPriceCents: 2000 }] },
        },
        include: { items: true },
      });
      const item = order.items[0];
      if (!item) throw new Error('ligne manquante');
      await tx.payment.create({
        data: { orderId: order.id, providerPaymentId: `pay_seed_${randomToken(9)}`, amountCents: 4000, currency: 'EUR', status: 'SUCCEEDED' },
      });
      for (let seq = 1; seq <= 2; seq += 1) {
        await tx.ticket.create({ data: { orderItemId: item.id, seq, eventId: jazz.id, publicId: randomBytes(16).toString('base64url') } });
      }
      await tx.ticketType.update({ where: { id: balcon.id }, data: { sold: { increment: 2 } } });
    });
  }

  // 4. Une commande par virement en attente pour l'acheteur de démo.
  const fosse = await db.ticketType.findFirstOrThrow({ where: { eventId: electro.id, name: 'Fosse' } });
  await db.$transaction(async (tx) => {
    const orderId = randomUUID();
    await tx.order.create({
      data: {
        id: orderId, userId: buyer.id, eventId: electro.id, status: 'AWAITING_TRANSFER', paymentMethod: 'TRANSFER',
        idempotencyKey: randomUUID(), requestHash: '0'.repeat(64),
        subtotalCents: 3600, serviceFeeCents: 0, totalCents: 3600, refundPercent: 100, serviceFeeRefundable: false,
        cancellableUntil: addHours(electro.startsAt, -48), expiresAt: addHours(now, 72),
        transferReference: transferReference(), transferBeneficiary: nuits.name,
        transferIbanEncrypted: encryptString(ibanPlain, env.dataKeyring, aad.orderTransferIban(orderId)), transferIbanMasked: maskIban(ibanPlain), transferBic: 'AGRIFRPP',
        items: { create: [{ ticketTypeId: fosse.id, quantity: 2, unitPriceCents: 1800 }] },
      },
    });
    await tx.ticketType.update({ where: { id: fosse.id }, data: { held: { increment: 2 } } });
  });

  // 5. Événements des collectifs partenaires (dont un brouillon).
  await db.event.create({
    data: {
      orgId: riveDroite.id, title: 'Rive Droite Block Party', status: 'PUBLISHED', timezone: 'Europe/Paris',
      venue: 'Parc aux Angéliques', address: 'Quai des Queyries, 33100 Bordeaux',
      startsAt: at(60, 14), endsAt: at(60, 22), salesStartAt: addHours(now, -2), salesEndAt: at(60, 14),
      maxPerOrder: 4, maxPerUser: 8,
      ticketTypes: { create: [{ name: 'Entrée', capacity: 300, priceCents: 1000 }, { name: 'Soutien', capacity: 50, priceCents: 2000, sortOrder: 1 }] },
    },
  });
  await db.event.create({
    data: {
      orgId: chais.id, title: 'Chais Sonores — édition hiver', status: 'DRAFT', timezone: 'Europe/Paris',
      venue: 'Chai Lafitte', startsAt: at(90, 19), endsAt: at(90, 23), salesStartAt: at(10, 8), salesEndAt: at(90, 19),
      ticketTypes: { create: [{ name: 'Placement libre', capacity: 80, priceCents: 1500 }, { name: 'Dégustation', capacity: 30, priceCents: 3000, sortOrder: 1 }] },
    },
  });

  out('Seed terminé. Comptes (tous vérifiés) :');
  out(`  admin plateforme : ${admin.email}`);
  out(`  acheteur         : ${buyer.email}`);
  for (const def of orgDefs) out(`  ${def.name.padEnd(26)}: owner@${def.prefix}.test · manager@${def.prefix}.test · scanner@${def.prefix}.test`);
  if (provided === '') {
    out(`Mot de passe commun généré (affiché une seule fois, non stocké) : ${password}`);
  } else {
    out('Mot de passe commun : valeur de SEED_PASSWORD.');
  }
}

main()
  .catch((err: unknown) => {
    process.stderr.write(`Échec du seed : ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  })
  .finally(() => disconnectDb());
