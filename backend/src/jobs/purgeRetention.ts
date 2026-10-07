import { LOGIN_LOCKOUT_RETENTION_MS, RETENTION } from '../config/retention.js';
import { RETENTION_DELETE_BATCH } from '../config/worker.js';
import { TimeBudget } from '../lib/budget.js';
import { clock } from '../lib/clock.js';
import { getDb } from '../lib/db.js';

const ago = (ms: number) => new Date(clock.now().getTime() - ms);

/**
 * Rétention des données personnelles (audit B8 ; durées dans config/retention.ts). Suppressions par lots de
 * RETENTION_DELETE_BATCH lignes (verrous courts), arrêt sur budget. L'AuditLog, les commandes, paiements et
 * billets ne sont jamais purgés ici.
 */
export async function purgeRetention(budget: TimeBudget = TimeBudget.unlimited()): Promise<Record<string, number>> {
  const db = getDb();
  const purges: [string, () => Promise<number>][] = [
    ['emailOutbox', () => db.$executeRaw`
      DELETE FROM "email_outbox" WHERE "id" IN (
        SELECT "id" FROM "email_outbox" WHERE "status" IN ('SENT', 'FAILED') AND "createdAt" < ${ago(RETENTION.outboxMs)}
        LIMIT ${RETENTION_DELETE_BATCH})`],
    ['emailTokens', () => db.$executeRaw`
      DELETE FROM "email_tokens" WHERE "id" IN (
        SELECT "id" FROM "email_tokens"
        WHERE "usedAt" < ${ago(RETENTION.emailTokensMs)} OR "expiresAt" < ${ago(RETENTION.emailTokensMs)}
        LIMIT ${RETENTION_DELETE_BATCH})`],
    ['refreshTokens', () => db.$executeRaw`
      DELETE FROM "refresh_tokens" WHERE "id" IN (
        SELECT "id" FROM "refresh_tokens"
        WHERE "expiresAt" < ${ago(RETENTION.refreshTokensMs)} OR "revokedAt" < ${ago(RETENTION.refreshTokensMs)}
        LIMIT ${RETENTION_DELETE_BATCH})`],
    ['webhookEvents', () => db.$executeRaw`
      DELETE FROM "webhook_events" WHERE "id" IN (
        SELECT "id" FROM "webhook_events" WHERE "receivedAt" < ${ago(RETENTION.webhookEventsMs)} LIMIT ${RETENTION_DELETE_BATCH})`],
    ['pspSessions', () => db.$executeRaw`
      DELETE FROM "psp_sessions" WHERE "id" IN (
        SELECT s."id" FROM "psp_sessions" s JOIN "orders" o ON o."id" = s."orderId"
        WHERE o."status" <> 'PENDING_PAYMENT' AND s."createdAt" < ${ago(RETENTION.pspSessionsMs)}
        LIMIT ${RETENTION_DELETE_BATCH})`],
    ['checkIns', () => db.$executeRaw`
      DELETE FROM "check_ins" WHERE "id" IN (
        SELECT c."id" FROM "check_ins" c JOIN "events" e ON e."id" = c."eventId"
        WHERE e."endsAt" < ${ago(RETENTION.checkInsAfterEventMs)}
        LIMIT ${RETENTION_DELETE_BATCH})`],
    ['loginLockouts', () => db.$executeRaw`
      DELETE FROM "login_lockouts" WHERE ("userId", "fingerprint") IN (
        SELECT "userId", "fingerprint" FROM "login_lockouts"
        WHERE "lastFailedAt" < ${ago(LOGIN_LOCKOUT_RETENTION_MS)} AND ("lockedUntil" IS NULL OR "lockedUntil" < ${clock.now()})
        LIMIT ${RETENTION_DELETE_BATCH})`],
  ];
  const deleted: Record<string, number> = {};
  for (const [name, purge] of purges) {
    let total = 0;
    for (;;) {
      if (budget.exhausted()) break;
      const n = await purge();
      total += n;
      if (n < RETENTION_DELETE_BATCH) break;
    }
    deleted[name] = total;
  }
  return deleted;
}
