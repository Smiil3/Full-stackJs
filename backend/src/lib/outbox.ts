import { randomUUID } from 'node:crypto';
import { getEnv } from '../config/env.js';
import { aad, decryptString, encryptString } from './crypto.js';
import { getDb, type Tx } from './db.js';
import { renderTemplate, type MailTemplate, type TemplatePayloads } from './mail/templates.js';
import QRCode from 'qrcode';
import { qrPayloadFor } from './ticketSigning.js';

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
    content: await QRCode.toBuffer(qrPayloadFor(t.eventId, t.publicId), { type: 'png', errorCorrectionLevel: 'M', margin: 2, width: 512 }),
    contentType: 'image/png',
  })));
}

export interface MailTransport {
  sendMail(message: MailMessage): Promise<unknown>;
}

export const OUTBOX_MAX_ATTEMPTS = 8;
const BATCH_SIZE = 20;

/** Délai avant nouvel essai : 30 s, 1 min, 2 min… plafonné à 1 h. */
export function backoffMs(attempts: number): number {
  return Math.min(30_000 * 2 ** Math.max(0, attempts - 1), 3_600_000);
}

interface OutboxRow {
  id: string;
  to: string;
  template: string;
  payload: unknown;
  attempts: number;
}

/**
 * Envoie un lot de mails en attente. `FOR UPDATE SKIP LOCKED` : plusieurs workers ne prennent jamais
 * le même mail. À chaque état terminal (SENT / FAILED), le payload est purgé.
 */
export async function processOutboxBatch(transport: MailTransport): Promise<{ sent: number; failed: number }> {
  const db = getDb();
  let sent = 0;
  let failed = 0;
  await db.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<OutboxRow[]>`
      SELECT "id", "to", "template", "payload", "attempts" FROM "email_outbox"
      -- Tolérance de 2 s : l'échéance est posée par l'application, comparée à l'horloge de la base.
      WHERE "status" = 'PENDING' AND "nextAttemptAt" <= now() + interval '2 seconds'
      ORDER BY "nextAttemptAt", "id"
      LIMIT ${BATCH_SIZE}
      FOR UPDATE SKIP LOCKED`;
    for (const row of rows) {
      try {
        const data = decryptOutboxPayload(row);
        const mail = renderTemplate(row.template as MailTemplate, data as never);
        const attachments = await attachmentsFor(row.template, data);
        await transport.sendMail({ from: getEnv().mailFrom, to: row.to, ...mail, ...(attachments ? { attachments } : {}) });
        await tx.emailOutbox.update({ where: { id: row.id }, data: { status: 'SENT', sentAt: new Date(), payload: {}, attempts: row.attempts + 1, lastError: null } });
        sent += 1;
      } catch (err) {
        const attempts = row.attempts + 1;
        const terminal = attempts >= OUTBOX_MAX_ATTEMPTS;
        const reason = err instanceof Error ? err.name : 'Error';
        await tx.emailOutbox.update({
          where: { id: row.id },
          data: terminal
            ? { status: 'FAILED', attempts, payload: {}, lastError: reason }
            : { attempts, nextAttemptAt: new Date(Date.now() + backoffMs(attempts)), lastError: reason },
        });
        if (terminal) failed += 1;
      }
    }
  }, { timeout: 60_000 });
  return { sent, failed };
}
