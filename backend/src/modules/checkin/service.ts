import type { CheckInResult, Prisma } from '../../generated/prisma/client.js';
import { clock } from '../../lib/clock.js';
import { getDb, transaction, type Tx } from '../../lib/db.js';
import { errors } from '../../lib/errors.js';
import { iso } from '../../lib/schemas.js';
import { holderInitials, publicKeyJwk, verifyQrPayload } from '../../lib/ticketSigning.js';

/** Événements à contrôler (SCANNER+) : publiés, terminés depuis moins de 24 h ; aucun chiffre de vente. */
export async function listCheckinEvents(orgId: string) {
  const since = new Date(clock.now().getTime() - 24 * 3600_000);
  const rows = await getDb().event.findMany({
    where: { orgId, status: 'PUBLISHED', endsAt: { gt: since } },
    select: { id: true, title: true, venue: true, isOnline: true, startsAt: true, endsAt: true, timezone: true, status: true },
    orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
    take: 100,
  });
  return {
    items: rows.map((e) => ({
      id: e.id, title: e.title, venue: e.venue, isOnline: e.isOnline,
      startsAt: iso(e.startsAt), endsAt: iso(e.endsAt), timezone: e.timezone, status: e.status,
    })),
  };
}

/** Événement du collectif (orgId dans le filtre) : sinon 404. */
async function eventOfOrg(db: Tx, orgId: string, eventId: string) {
  const event = await db.event.findFirst({ where: { id: eventId, orgId }, select: { id: true, salesStartAt: true } });
  if (!event) throw errors.notFound();
  return event;
}

const ticketInclude = {
  orderItem: { select: { ticketType: { select: { name: true } }, order: { select: { user: { select: { displayName: true } } } } } },
} satisfies Prisma.TicketInclude;
type TicketWithHolder = Prisma.TicketGetPayload<{ include: typeof ticketInclude }>;

function brief(t: TicketWithHolder) {
  return { publicId: t.publicId, ticketTypeName: t.orderItem.ticketType.name, holderInitials: holderInitials(t.orderItem.order.user.displayName) };
}

/** Liste téléchargée par la PWA avant l'ouverture des portes (vérification hors-ligne). */
export async function snapshot(orgId: string, eventId: string) {
  const db = getDb();
  await eventOfOrg(db, orgId, eventId);
  const tickets = await db.ticket.findMany({ where: { eventId }, include: ticketInclude, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
  return {
    eventId,
    generatedAt: iso(clock.now()),
    publicKeyJwk: publicKeyJwk(),
    tickets: tickets.map((t) => ({ ...brief(t), status: t.status, usedAt: iso(t.usedAt) })),
  };
}

interface ScanInput {
  orgId: string;
  eventId: string;
  scannerId: string;
  deviceId: string;
  scanId: string;
  qrPayload: string;
  /** Horodatage retenu (serveur en ligne, appareil borné hors-ligne). */
  scannedAt: Date;
  clientScannedAt: Date | null;
  clamped: boolean;
  offline: boolean;
}

export interface ScanOutcome {
  result: CheckInResult;
  ticket: { publicId: string; ticketTypeName: string; holderInitials: string } | null;
  usedAt: string | null;
}

/**
 * Un scan, dans sa propre transaction :
 * 1. le scanId est réservé (CheckIn.scanId UNIQUE) : un scanId rejoué renvoie le résultat d'origine, sans effet ;
 * 2. QR vérifié (format strict + signature Ed25519) ; QR d'un autre événement ⇒ WRONG_EVENT ;
 * 3. passage atomique VALID → USED (`UPDATE … WHERE status = 'VALID'`) : deux scans simultanés du même
 *    billet ⇒ un seul OK, l'autre ALREADY_USED — même depuis le même appareil.
 */
export async function scanOne(input: ScanInput): Promise<ScanOutcome> {
  return transaction(async (tx) => {
    const reserved = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO "check_ins" ("id", "scanId", "eventId", "scannerId", "deviceId", "scannedAt", "clientScannedAt", "scannedAtClamped", "result", "offline")
      VALUES (gen_random_uuid(), ${input.scanId}::uuid, ${input.eventId}::uuid, ${input.scannerId}::uuid, ${input.deviceId}::uuid,
              ${input.scannedAt}, ${input.clientScannedAt}, ${input.clamped}, 'INVALID', ${input.offline})
      ON CONFLICT ("scanId") DO NOTHING
      RETURNING "id"`;
    const checkInId = reserved[0]?.id;
    if (!checkInId) return replayed(tx, input);

    const record = async (result: CheckInResult, ticketId: string | null): Promise<void> => {
      await tx.checkIn.update({ where: { id: checkInId }, data: { result, ticketId } });
    };

    const qr = verifyQrPayload(input.qrPayload);
    if (!qr.ok) {
      await record('INVALID', null);
      return { result: 'INVALID', ticket: null, usedAt: null };
    }
    if (qr.eventId !== input.eventId) {
      await record('WRONG_EVENT', null);
      return { result: 'WRONG_EVENT', ticket: null, usedAt: null };
    }
    const used = await tx.$queryRaw<{ id: string; usedAt: Date }[]>`
      UPDATE "tickets"
      SET "status" = 'USED', "usedAt" = ${input.scannedAt}, "usedByUserId" = ${input.scannerId}::uuid, "usedDeviceId" = ${input.deviceId}::uuid
      WHERE "publicId" = ${qr.publicId} AND "eventId" = ${input.eventId}::uuid AND "status" = 'VALID'
      RETURNING "id", "usedAt"`;
    const ticket = await tx.ticket.findFirst({ where: { publicId: qr.publicId, eventId: input.eventId }, include: ticketInclude });
    if (!ticket) {
      // Signature valide mais billet inconnu : clé compromise ou base incohérente.
      await record('INVALID', null);
      return { result: 'INVALID', ticket: null, usedAt: null };
    }
    const result: CheckInResult = used.length === 1 ? 'OK' : ticket.status === 'CANCELLED' ? 'CANCELLED' : 'ALREADY_USED';
    await record(result, ticket.id);
    return { result, ticket: brief(ticket), usedAt: result === 'CANCELLED' ? null : iso(ticket.usedAt) };
  });
}

/** scanId déjà connu : résultat d'origine, sans nouvel effet (même événement uniquement). */
async function replayed(tx: Tx, input: ScanInput): Promise<ScanOutcome> {
  const original = await tx.checkIn.findUnique({ where: { scanId: input.scanId }, include: { ticket: { include: ticketInclude } } });
  if (!original || original.eventId !== input.eventId) return { result: 'INVALID', ticket: null, usedAt: null };
  const ticket = original.ticket;
  return {
    result: original.result,
    ticket: ticket ? brief(ticket) : null,
    usedAt: ticket && original.result !== 'CANCELLED' ? iso(ticket.usedAt) : null,
  };
}

export async function scan(orgId: string, eventId: string, scannerId: string, body: { qrPayload: string; deviceId: string; scanId: string }) {
  await eventOfOrg(getDb(), orgId, eventId);
  const now = clock.now();
  return scanOne({ orgId, eventId, scannerId, ...body, scannedAt: now, clientScannedAt: null, clamped: false, offline: false });
}

const FUTURE_TOLERANCE_MS = 5 * 60_000;

/**
 * Synchronisation des scans hors-ligne : traités dans l'ordre `scannedAt` (puis ordre d'arrivée), le premier
 * gagne ; `scannedAt` est borné à [début des ventes, maintenant + 5 min] (le bornage est journalisé) et ne
 * permet jamais de contourner un billet déjà utilisé. Résultats renvoyés dans l'ordre de la requête.
 */
export async function sync(orgId: string, eventId: string, scannerId: string, body: { deviceId: string; scans: { scanId: string; qrPayload: string; scannedAt: string }[] }) {
  const event = await eventOfOrg(getDb(), orgId, eventId);
  const now = clock.now().getTime();
  const min = event.salesStartAt.getTime();
  const max = now + FUTURE_TOLERANCE_MS;
  const ordered = body.scans
    .map((s, index) => ({ ...s, index, client: new Date(s.scannedAt) }))
    .sort((a, b) => a.client.getTime() - b.client.getTime() || a.index - b.index);
  const byScanId = new Map<string, { scanId: string; result: 'ACCEPTED' | Exclude<CheckInResult, 'OK'>; usedAt: string | null }>();
  for (const s of ordered) {
    const clampedTime = Math.min(Math.max(s.client.getTime(), min), max);
    const outcome = await scanOne({
      orgId, eventId, scannerId, deviceId: body.deviceId, scanId: s.scanId, qrPayload: s.qrPayload,
      scannedAt: new Date(clampedTime), clientScannedAt: s.client, clamped: clampedTime !== s.client.getTime(), offline: true,
    });
    byScanId.set(s.scanId, { scanId: s.scanId, result: outcome.result === 'OK' ? 'ACCEPTED' : outcome.result, usedAt: outcome.usedAt });
  }
  return { results: body.scans.map((s) => byScanId.get(s.scanId) ?? { scanId: s.scanId, result: 'INVALID' as const, usedAt: null }) };
}
