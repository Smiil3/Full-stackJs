import { randomUUID } from 'node:crypto';
import { getEnv } from '../config/env.js';
import { aad, decryptString, encryptString } from './crypto.js';
import { getDb, type Tx } from './db.js';
import { clock } from './clock.js';
import { getLogger } from './logger.js';
import { renderTemplate, type MailTemplate, type TemplatePayloads } from './mail/templates.js';
import QRCode from 'qrcode';
import { qrPayloadFor } from './ticketSigning.js';
import { BACKOFF_BASE_MS, BACKOFF_FACTOR, BACKOFF_MAX_MS, OUTBOX_BATCH, OUTBOX_LEASE_MS, OUTBOX_MAX_ATTEMPTS, QR_IMAGE_MARGIN, QR_IMAGE_WIDTH_PX } from '../config/mail.js';

/** Payload stocké : uniquement chiffré (les liens de vérification / reset contiennent des jetons). */
// Alias (et non interface) : compatible avec le type JSON attendu par Prisma.
type StoredPayload = { v: 1; enc: string };

/**
 * Ajoute un mail à l'outbox DANS la transaction de l'événement métier : si la transaction échoue,
 * aucun mail ne part ; si elle réussit, le worker l'enverra (retry exponentiel).
 * Le payload est chiffré (AES-256-GCM, AAD `outbox:<id>`) : aucun lien utilisable en clair en base.
 */
export async function enqueueEmail<T extends MailTemplate>(tx: Tx, to: string, template: T, payload: TemplatePayloads[T]): Promise<void> {
  const id = randomUUID();
  const stored: StoredPayload = { v: 1, enc: encryptString(JSON.stringify(payload), getEnv().dataKeyring, aad.outboxPayload(id)) };
  await tx.emailOutbox.create({ data: { id, to, template, payload: stored } });
}

export function decryptOutboxPayload(row: { id: string; payload: unknown }): Record<string, unknown> {
  const stored = row.payload as Partial<StoredPayload> | null;
  if (stored?.v !== 1 || typeof stored.enc !== 'string') throw new Error('Payload d’outbox illisible ou déjà purgé');
  return JSON.parse(decryptString(stored.enc, getEnv().dataKeyring, aad.outboxPayload(row.id))) as Record<string, unknown>;
}

export interface MailMessage {
  /** Identifiant de message stable (dédoublonnage en cas de renvoi). */
  messageId?: string;
  from: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  attachments?: { filename: string; content: Buffer; contentType: string }[];
}

/** Pièces jointes calculées à l'envoi (jamais stockées) : QR code de chaque billet d'une commande confirmée. */
async function attachmentsFor(template: string, data: Record<string, unknown>): Promise<MailMessage['attachments']> {
  if (template !== 'orderConfirmed' || typeof data['orderId'] !== 'string') return undefined;
  const tickets = await getDb().ticket.findMany({
    where: { orderItem: { orderId: data['orderId'] }, status: 'VALID' },
    orderBy: [{ orderItemId: 'asc' }, { seq: 'asc' }],
  });
  return Promise.all(tickets.map(async (t, i) => ({
    filename: `billet-${i + 1}.png`,
    content: await QRCode.toBuffer(qrPayloadFor(t.eventId, t.publicId), { type: 'png', errorCorrectionLevel: 'M', margin: QR_IMAGE_MARGIN, width: QR_IMAGE_WIDTH_PX }),
    contentType: 'image/png',
  })));
}

export interface MailTransport {
  sendMail(message: MailMessage): Promise<unknown>;
}

/** Délai avant nouvel essai : 30 s, 1 min, 2 min… plafonné à 1 h. */
export function backoffMs(attempts: number): number {
  return Math.min(BACKOFF_BASE_MS * BACKOFF_FACTOR ** Math.max(0, attempts - 1), BACKOFF_MAX_MS);
}

interface OutboxRow {
  id: string;
  to: string;
  template: string;
  payload: unknown;
  attempts: number;
}

/** Message-ID stable par ligne d'outbox : un renvoi après incident est dédoublonnable côté SMTP / client mail. */
export function messageIdFor(outboxId: string): string {
  return `<outbox-${outboxId}@nuits-garonne.billetterie>`;
}

/**
 * Envoie un lot de mails en attente (même schéma que les remboursements) :
 * 1. transaction COURTE : sélection `FOR UPDATE SKIP LOCKED`, tentative comptée et bail posé ;
 * 2. envoi SMTP HORS transaction (un SMTP lent ne fait plus échouer / rejouer le lot) ;
 * 3. mise à jour ligne par ligne, gardée par le statut PENDING ; payload purgé à l'état terminal.
 * Garantie « au moins une fois » : un crash entre l'envoi et la mise à jour peut provoquer un renvoi après
 * expiration du bail, avec le même Message-ID.
 */
export async function processOutboxBatch(transport: MailTransport): Promise<{ sent: number; failed: number }> {
  const db = getDb();
  const now = clock.now();
  const leased = await db.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<OutboxRow[]>`
      SELECT "id", "to", "template", "payload", "attempts" FROM "email_outbox"
      WHERE "status" = 'PENDING' AND "nextAttemptAt" <= ${now}
      ORDER BY "nextAttemptAt", "id"
      LIMIT ${OUTBOX_BATCH}
      FOR UPDATE SKIP LOCKED`;
    if (rows.length > 0) {
      await tx.$executeRaw`
        UPDATE "email_outbox" SET "attempts" = "attempts" + 1, "nextAttemptAt" = ${new Date(now.getTime() + OUTBOX_LEASE_MS)}
        WHERE "id" = ANY(${rows.map((r) => r.id)}::uuid[])`;
    }
    return rows.map((r) => ({ ...r, attempts: r.attempts + 1 }));
  });
  let sent = 0;
  let failed = 0;
  for (const row of leased) {
    try {
      try {
        const data = decryptOutboxPayload(row);
        const mail = renderTemplate(row.template as MailTemplate, data as never);
        const attachments = await attachmentsFor(row.template, data);
        await transport.sendMail({
          from: getEnv().mailFrom, to: row.to, ...mail, messageId: messageIdFor(row.id), ...(attachments ? { attachments } : {}),
        });
        await db.emailOutbox.updateMany({ where: { id: row.id, status: 'PENDING' }, data: { status: 'SENT', sentAt: clock.now(), payload: {}, lastError: null } });
        sent += 1;
      } catch (err) {
        const terminal = row.attempts >= OUTBOX_MAX_ATTEMPTS;
        const reason = err instanceof Error ? err.name : 'Error';
        await db.emailOutbox.updateMany({
          where: { id: row.id, status: 'PENDING' },
          data: terminal
            ? { status: 'FAILED', payload: {}, lastError: reason }
            : { nextAttemptAt: new Date(clock.now().getTime() + backoffMs(row.attempts)), lastError: reason },
        });
        if (terminal) failed += 1;
      }
    } catch (err) {
      // Erreur de base : le bail expirera et le mail sera repris ; le lot continue.
      getLogger().error({ err, outboxId: row.id }, 'échec de mise à jour d’un mail de l’outbox');
    }
  }
  return { sent, failed };
}
