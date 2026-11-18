import type { EventReschedule, OrderStatus } from '../../generated/prisma/client.js';
import { clock } from '../../lib/clock.js';
import { getDb, transaction, type Tx } from '../../lib/db.js';
import { getLogger } from '../../lib/logger.js';
import { enqueueEmail } from '../../lib/outbox.js';
import { formatWithZone } from '../../lib/time.js';
import { withTxRetry } from '../../lib/txRetry.js';
import { PERCENT_MAX } from '../../config/money.js';
import { hours } from '../../config/units.js';
import { MAX_RESCHEDULE_FAILURES, RESCHEDULE_ORDERS_PER_TICK } from '../../config/worker.js';
import { TimeBudget } from '../../lib/budget.js';

const ACTIVE: readonly OrderStatus[] = ['PENDING_PAYMENT', 'AWAITING_TRANSFER', 'PAID'];

/** Champs d'une commande que le report modifie. */
interface RightsFields { status: OrderStatus; cancellableUntil: Date | null; expiresAt: Date | null }

/**
 * Droits d'une commande après un report (contrat §7.2) — calcul pur, partagé par l'application réelle et par
 * l'aperçu des vues (une commande pas encore traitée par le worker affiche déjà ses nouveaux droits).
 */
export function rescheduledRights(job: EventReschedule, order: RightsFields) {
  const deadlineMs = order.cancellableUntil
    ? job.oldStartsAt.getTime() - order.cancellableUntil.getTime()
    : hours(job.fallbackDeadlineHours);
  const candidate = job.newStartsAt.getTime() - deadlineMs;
  const cancellableUntil = new Date(Math.max(order.cancellableUntil?.getTime() ?? candidate, candidate));
  const expiresAt = order.status === 'PAID' || order.status === 'EXPIRED' || !order.expiresAt || order.expiresAt <= job.newStartsAt
    ? order.expiresAt : job.newStartsAt;
  return { cancellableUntil, refundPercent: PERCENT_MAX, serviceFeeRefundable: true, expiresAt };
}

/** Statuts qui reçoivent les droits du report : actifs, et EXPIRED (un paiement tardif peut encore la reprendre). */
const RIGHTS_STATUSES: readonly OrderStatus[] = [...ACTIVE, 'EXPIRED'];

/**
 * Applique un report à UNE commande déjà verrouillée (FOR UPDATE) — contrat §7.2 :
 * remboursement intégral (100 %, frais compris), nouvelle limite d'annulation = max(ancienne, nouveau début − délai
 * figé), échéance d'une commande non payée ramenée au nouveau début ; au plus UN mail par acheteur et par report
 * (table reschedule_notifications), daté dans le fuseau de l'événement après le report (audit B6).
 */
async function applyToLockedOrder(tx: Tx, job: EventReschedule, orderId: string): Promise<void> {
  const order = await tx.order.findUniqueOrThrow({
    where: { id: orderId },
    select: {
      id: true, status: true, userId: true, cancellableUntil: true, expiresAt: true, pendingRescheduleId: true,
      user: { select: { email: true, displayName: true } }, event: { select: { title: true, status: true } },
    },
  });
  if (order.pendingRescheduleId !== job.id) return;
  if (!RIGHTS_STATUSES.includes(order.status)) {
    await tx.order.update({ where: { id: order.id }, data: { pendingRescheduleId: null } });
    return;
  }
  // Commande EXPIRED pendant le traitement (audit M'3) : droits posés, pour qu'un paiement tardif qui la reprend
  // ne revienne pas aux anciennes règles ; pas de mail (la réservation n'existe plus pour l'acheteur).
  await tx.order.update({ where: { id: order.id }, data: { ...rescheduledRights(job, order), pendingRescheduleId: null } });
  if (order.status === 'EXPIRED') return;
  // Événement annulé entre-temps : les droits sont posés, mais pas de mail de report (le mail d'annulation suit).
  if (order.event.status === 'CANCELLED') return;
  const first = await tx.$queryRaw<{ userId: string }[]>`
    INSERT INTO "reschedule_notifications" ("rescheduleId", "userId") VALUES (${job.id}::uuid, ${order.userId}::uuid)
    ON CONFLICT DO NOTHING RETURNING "userId"`;
  if (first.length === 0) return;
  await enqueueEmail(tx, order.user.email, 'eventRescheduled', {
    displayName: order.user.displayName,
    eventTitle: order.event.title,
    oldDate: formatWithZone(job.oldStartsAt, job.oldTimezone),
    newDate: formatWithZone(job.newStartsAt, job.newTimezone),
    reason: job.reason,
  });
}

/**
 * Commande verrouillée qui attend encore son report : appliqué d'abord. Appelé par `loadOrderForUpdate` (paiement,
 * paiement tardif, virement, annulation…) et par l'expiration : aucune transition ne se fait sur d'anciens droits.
 */
export async function applyPendingReschedule(tx: Tx, order: { id: string; pendingRescheduleId: string | null }): Promise<boolean> {
  if (order.pendingRescheduleId === null) return false;
  const job = await tx.eventReschedule.findUniqueOrThrow({ where: { id: order.pendingRescheduleId } });
  await applyToLockedOrder(tx, job, order.id);
  return true;
}

/**
 * Worker : reports en arrière-plan (audit B7), UNE TRANSACTION PAR COMMANDE (`FOR UPDATE SKIP LOCKED`),
 * idempotent (la commande traitée perd son `pendingRescheduleId`) et repris au passage suivant ;
 * un report sans commande restante est marqué terminé (un nouveau report devient possible).
 */
export async function processEventReschedules(budget: TimeBudget = TimeBudget.unlimited()): Promise<{ processed: number; failed: number; completed: number }> {
  let processed = 0;
  let failed = 0;
  const skipped: string[] = [];
  for (let i = 0; i < RESCHEDULE_ORDERS_PER_TICK && !budget.exhausted(); i += 1) {
    const current: { id: string | null } = { id: null };
    try {
      const done = await withTxRetry(() => transaction(async (tx) => {
        const rows = await tx.$queryRaw<{ id: string; pendingRescheduleId: string }[]>`
          SELECT "id", "pendingRescheduleId" FROM "orders"
          WHERE "pendingRescheduleId" IS NOT NULL AND "rescheduleFailures" < ${MAX_RESCHEDULE_FAILURES}
            AND NOT ("id" = ANY(${skipped}::uuid[]))
          ORDER BY "id" LIMIT 1
          FOR UPDATE SKIP LOCKED`;
        const row = rows[0];
        if (!row) return false;
        current.id = row.id;
        await applyPendingReschedule(tx, row);
        return true;
      }));
      if (!done) break;
      processed += 1;
    } catch (err) {
      const id = current.id;
      if (id === null) throw err;
      skipped.push(id);
      failed += 1;
      // Échecs comptés : au-delà de MAX_RESCHEDULE_FAILURES, la commande est écartée et le report apparaît dans
      // /admin/stuck-reschedules (audit B'6) au lieu d'être réessayé indéfiniment.
      const { rescheduleFailures } = await getDb().order.update({
        where: { id }, data: { rescheduleFailures: { increment: 1 } }, select: { rescheduleFailures: true },
      });
      getLogger().error({ err, orderId: id, rescheduleFailures }, rescheduleFailures >= MAX_RESCHEDULE_FAILURES
        ? 'commande écartée de l’application d’un report : intervention de l’admin plateforme requise'
        : 'échec de l’application d’un report à une commande (repris au prochain passage)');
    }
  }
  const completed = await getDb().$executeRaw`
    UPDATE "event_reschedules" r SET "completedAt" = ${clock.now()}
    WHERE r."completedAt" IS NULL AND NOT EXISTS (SELECT 1 FROM "orders" o WHERE o."pendingRescheduleId" = r."id")`;
  return { processed, failed, completed };
}

/** Champs d'aperçu d'une commande. */
interface PreviewFields extends RightsFields { pendingRescheduleId: string | null; refundPercent: number; serviceFeeRefundable: boolean }

/**
 * Vues de commande (Info audit) : une commande marquée par un report pas encore appliqué affiche DÉJÀ ses droits
 * à venir (aperçu de remboursement, limite d'annulation), calculés par la même fonction que l'application réelle.
 */
export async function withPendingRights<T extends PreviewFields>(db: Tx, orders: T[]): Promise<T[]> {
  const ids = [...new Set(orders.map((o) => o.pendingRescheduleId).filter((id): id is string => id !== null))];
  if (ids.length === 0) return orders;
  const jobs = new Map((await db.eventReschedule.findMany({ where: { id: { in: ids } } })).map((j) => [j.id, j]));
  return orders.map((o) => {
    const job = o.pendingRescheduleId === null ? undefined : jobs.get(o.pendingRescheduleId);
    if (!job || !RIGHTS_STATUSES.includes(o.status)) return o;
    return { ...o, ...rescheduledRights(job, o) };
  });
}
